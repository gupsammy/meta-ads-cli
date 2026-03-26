import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { graphRequestWithRetry } from '../lib/http.js';
import { resolveAccessToken } from '../auth.js';
import type {
  CreativeMediaEntry,
  CreativeManifestEntry,
  AnalyzeCreativesOptions,
  AnalyzeCreativesResult,
  Orientation,
  VideoMetadata,
  ImageMetadata,
} from './types.js';

const MAX_FRAMES = 6;

// ─── Helpers ────────────────────────────────────────────────────

/** Strip non-alphanumeric/underscore/dash and truncate to 64 chars. */
export function sanitizeAdId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

/** Determine orientation from width/height. Uses multiplication form to avoid division-by-zero. */
export function computeOrientation(w: number, h: number): Orientation {
  if (!w || !h) return 'square';
  if (w > h * 1.2) return 'landscape';
  if (h > w * 1.2) return 'portrait';
  return 'square';
}

/** Download a binary file from a URL with retry (for pre-signed CDN links, no auth). */
async function fetchMediaWithRetry(url: string, destPath: string, maxRetries = 3): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= maxRetries) break;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      continue;
    }

    // Non-retryable client errors (except 429)
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new Error(`HTTP ${response.status} downloading ${url}`);
    }

    if (response.ok && response.body) {
      const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream);
      await pipeline(nodeStream, fs.createWriteStream(destPath));
      return;
    }

    // Retryable: 429 or 5xx or missing body
    lastError = new Error(`HTTP ${response.status}${!response.body ? ': empty body' : ''}`);
    if (attempt >= maxRetries) break;
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, delay));
  }
  throw lastError ?? new Error(`Failed to download ${url}`);
}

/** Run ffprobe and return stdout as string. */
function runFfprobe(args: string[]): string {
  return execFileSync('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 }).toString();
}

/** Extract video metadata via ffprobe. */
function extractVideoMeta(videoPath: string): VideoMetadata {
  const raw = runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath]);
  const data = JSON.parse(raw);
  const fmt = data.format ?? {};
  const stream = (data.streams ?? [{}])[0];
  const w = stream.width ?? null;
  const h = stream.height ?? null;
  return {
    type: 'video',
    duration: Math.round((parseFloat(fmt.duration ?? '0')) * 10) / 10,
    width: w,
    height: h,
    aspect_ratio: stream.display_aspect_ratio ?? '',
    codec: stream.codec_name ?? '',
    orientation: w && h ? computeOrientation(w, h) : 'square',
  };
}

/** Extract image metadata via ffprobe. */
function extractImageMeta(imagePath: string): ImageMetadata {
  const raw = runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_streams', imagePath]);
  const data = JSON.parse(raw);
  const stream = (data.streams ?? [{}])[0];
  const w: number = stream.width ?? 0;
  const h: number = stream.height ?? 0;
  return {
    type: 'image',
    width: w,
    height: h,
    orientation: computeOrientation(w, h),
  };
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Per-ad processors ──────────────────────────────────────────

interface CreativeApiResponse {
  object_story_spec?: {
    video_data?: { video_id?: string };
    link_data?: { image_hash?: string };
  };
  thumbnail_url?: string;
  image_url?: string;
  error?: { message?: string };
}

interface VideoApiResponse {
  source?: string;
  length?: number;
}

async function processVideoAd(
  adDir: string,
  videoId: string,
  token: string,
  thumbnailUrl: string | undefined,
  warnings: string[],
): Promise<void> {
  // Fetch video details (source URL + duration)
  let videoJson: VideoApiResponse | undefined;
  try {
    videoJson = await graphRequestWithRetry<VideoApiResponse>(
      `/${videoId}`,
      token,
      { params: { fields: 'source,length' } },
    );
  } catch {
    // Don't return early — fall through to thumbnail fallback
    warnings.push(`Video API error for ${videoId}`);
  }

  const sourceUrl = videoJson?.source;
  if (!sourceUrl) {
    // Fallback to thumbnail (covers both API error and missing source URL)
    const errorType = videoJson === undefined ? 'video_api_error' : 'no_source_url';
    if (thumbnailUrl) {
      try {
        await fetchMediaWithRetry(thumbnailUrl, path.join(adDir, 'thumbnail.png'));
      } catch { /* best-effort */ }
      writeJson(path.join(adDir, 'metadata.json'), { type: 'video', error: errorType, fallback: 'thumbnail' });
    } else {
      writeJson(path.join(adDir, 'metadata.json'), { type: 'video', error: errorType });
    }
    return;
  }

  const rawPath = path.join(adDir, '_raw.mp4');
  const videoPath = path.join(adDir, '_video.mp4');

  // Download video
  try {
    await fetchMediaWithRetry(sourceUrl, rawPath);
  } catch {
    writeJson(path.join(adDir, 'metadata.json'), { type: 'video', error: 'download_failed' });
    warnings.push(`Video download failed for ${path.basename(adDir)}`);
    try { fs.unlinkSync(rawPath); } catch { /* may not exist */ }
    return;
  }

  // Transcode: 480px wide, 300k bitrate, no audio, max 60s
  try {
    execFileSync('ffmpeg', [
      '-i', rawPath, '-vf', 'scale=480:-1', '-b:v', '300k',
      '-an', '-t', '60', '-y', '-loglevel', 'error', videoPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
    try { fs.unlinkSync(rawPath); } catch { /* ok */ }
  } catch {
    // Transcode failed — use raw file
    warnings.push(`ffmpeg transcode failed for ${path.basename(adDir)}, using raw`);
    fs.renameSync(rawPath, videoPath);
  }

  // Extract metadata
  let meta: VideoMetadata;
  try {
    meta = extractVideoMeta(videoPath);
  } catch {
    writeJson(path.join(adDir, 'metadata.json'), { type: 'video', error: 'metadata_extraction_failed' });
    warnings.push(`ffprobe metadata failed for ${path.basename(adDir)}`);
    try { fs.unlinkSync(videoPath); } catch { /* ok */ }
    return;
  }
  writeJson(path.join(adDir, 'metadata.json'), meta);

  // Extract evenly-spaced frames
  const interval = Math.max(0.5, meta.duration / Math.max(1, MAX_FRAMES - 1));
  try {
    execFileSync('ffmpeg', [
      '-i', videoPath, '-vf', `fps=1/${interval},scale=480:-1`,
      '-vframes', String(MAX_FRAMES), '-y', '-loglevel', 'error',
      path.join(adDir, 'frame_%02d.png'),
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
  } catch { /* best-effort */ }

  // Last frame (CTA/closing shot) at -0.3s before end
  try {
    execFileSync('ffmpeg', [
      '-sseof', '-0.3', '-i', videoPath, '-vframes', '1',
      '-vf', 'scale=480:-1', '-y', '-loglevel', 'error',
      path.join(adDir, 'frame_last.png'),
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
  } catch { /* best-effort */ }

  // Clean up video files
  try { fs.unlinkSync(videoPath); } catch { /* ok */ }
  try { fs.unlinkSync(rawPath); } catch { /* may already be gone */ }
}

async function processImageAd(
  adDir: string,
  creativeJson: CreativeApiResponse,
  warnings: string[],
): Promise<void> {
  // Prefer thumbnail_url, fall back to image_url
  const imgUrl = creativeJson.thumbnail_url || creativeJson.image_url;
  if (!imgUrl) {
    writeJson(path.join(adDir, 'metadata.json'), { type: 'unknown', error: 'no_media_url' });
    return;
  }

  const imgPath = path.join(adDir, 'image.png');
  try {
    await fetchMediaWithRetry(imgUrl, imgPath);
  } catch {
    writeJson(path.join(adDir, 'metadata.json'), { type: 'image', error: 'download_failed' });
    warnings.push(`Image download failed for ${path.basename(adDir)}`);
    return;
  }

  try {
    const meta = extractImageMeta(imgPath);
    writeJson(path.join(adDir, 'metadata.json'), meta);
  } catch {
    writeJson(path.join(adDir, 'metadata.json'), { type: 'image', error: 'metadata_extraction_failed' });
    warnings.push(`ffprobe metadata failed for ${path.basename(adDir)}`);
  }
}

// ─── Manifest builder ───────────────────────────────────────────

function buildManifest(
  creativesDir: string,
  tmpDir: string,
  inputEntries: CreativeMediaEntry[],
): { manifest: CreativeManifestEntry[]; totalFrames: number } {
  const manifest: CreativeManifestEntry[] = [];
  let totalFrames = 0;

  for (const entry of inputEntries) {
    const adId = sanitizeAdId(String(entry.ad_id ?? entry.ad_name ?? ''));
    if (!adId) continue;
    const adDir = path.join(tmpDir, adId);
    if (!fs.existsSync(adDir) || !fs.statSync(adDir).isDirectory()) continue;

    const metaPath = path.join(adDir, 'metadata.json');
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch { /* use empty defaults */ }

    const frames = fs.readdirSync(adDir)
      .filter(f => f.endsWith('.png'))
      .sort();
    totalFrames += frames.length;

    // Shell used explicit roas/cpa keys from input JSON. TS schema uses
    // primary_metric_name/primary_metric_value, so map them conditionally.
    manifest.push({
      ad_id: adId,
      ad_name: entry.ad_name ?? '',
      rank: entry.rank,
      roas: entry.primary_metric_name === 'roas' ? entry.primary_metric_value : 0,
      cpa: entry.primary_metric_name === 'cpa' ? entry.primary_metric_value : 0,
      media_type: (metadata.type as string) ?? 'unknown',
      duration: (metadata.duration as number) ?? null,
      orientation: (metadata.orientation as string) ?? 'unknown',
      frames,
      frame_count: frames.length,
      // Use final creativesDir path, not the temp dir
      artifacts_dir: path.join(creativesDir, adId),
    });
  }

  return { manifest, totalFrames };
}

// ─── Main export ────────────────────────────────────────────────

export async function analyzeCreatives(options: AnalyzeCreativesOptions): Promise<AnalyzeCreativesResult> {
  const dataDir = options.dataDir
    ?? process.env['META_ADS_DATA_DIR']
    ?? path.join(homedir(), '.meta-ads-intel', 'data');
  const creativesDir = path.join(path.dirname(dataDir), 'creatives');
  const creativesMasterPath = path.join(dataDir, 'creatives-master.json');
  const warnings: string[] = [];

  // Security: restrict file permissions (ad spend data is sensitive)
  let oldUmask: number | undefined;
  try { oldUmask = process.umask(0o077); } catch { /* worker thread */ }

  const tmpDir = `${creativesDir}._tmp_${process.pid}`;
  let backupSafeToDelete = false;

  try {
    // Validate inputs
    if (!fs.existsSync(options.inputFile)) {
      throw new Error(`Input file not found: ${options.inputFile}`);
    }
    if (!fs.existsSync(creativesMasterPath)) {
      throw new Error('creatives-master.json not found. Run intel run first.');
    }

    const inputEntries: CreativeMediaEntry[] = JSON.parse(fs.readFileSync(options.inputFile, 'utf8'));
    if (!Array.isArray(inputEntries) || inputEntries.length === 0) {
      return { creatives_dir: creativesDir, total_ads: 0, total_frames: 0, manifest: [], warnings };
    }

    // Build creative_id lookup: ad_id → creative_id
    const rawMaster = JSON.parse(fs.readFileSync(creativesMasterPath, 'utf8'));
    const masterData: Array<{ id: string; creative_id?: string }> = rawMaster.data ?? rawMaster;
    const creativeLookup: Record<string, string> = {};
    for (const entry of masterData) {
      if (entry.id && entry.creative_id) {
        creativeLookup[entry.id] = entry.creative_id;
      }
    }

    // Resolve access token
    const token = resolveAccessToken(options.accessToken);
    if (!token) {
      throw new Error('No access token. Set META_ADS_ACCESS_TOKEN or run: meta-ads auth login');
    }

    // Prepare temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    console.error(`Extracting creative artifacts for ${inputEntries.length} ads...`);

    // Process ads in chunks for concurrency (limits parallel API calls)
    const CONCURRENCY = 3;
    const processAd = async (entry: CreativeMediaEntry, i: number) => {
      const rawId = String(entry.ad_id ?? entry.ad_name ?? '');
      const adId = sanitizeAdId(rawId);
      if (!adId) {
        warnings.push(`Empty ad ID at index ${i}, skipping`);
        return;
      }

      const adDir = path.join(tmpDir, adId);
      fs.mkdirSync(adDir, { recursive: true });

      console.error(`  [${i + 1}/${inputEntries.length}] ${entry.ad_name ?? adId} (${entry.rank})`);

      try {
        // Look up creative_id
        const creativeId = creativeLookup[rawId];
        if (!creativeId) {
          writeJson(path.join(adDir, 'metadata.json'), { error: 'no_creative_id' });
          warnings.push(`No creative_id for ad ${adId}`);
          return;
        }

        // Fetch creative details from Meta API
        let creativeJson: CreativeApiResponse;
        try {
          creativeJson = await graphRequestWithRetry<CreativeApiResponse>(
            `/${creativeId}`,
            token,
            { params: { fields: 'object_story_spec,thumbnail_url,image_url' } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(path.join(adDir, 'metadata.json'), { error: 'api_error', message: msg });
          warnings.push(`API error for ad ${adId}: ${msg}`);
          return;
        }

        // Check for API-level error in response
        if (creativeJson.error?.message) {
          writeJson(path.join(adDir, 'metadata.json'), { error: 'api_error', message: creativeJson.error.message });
          warnings.push(`API error for ad ${adId}: ${creativeJson.error.message}`);
          return;
        }

        // Determine media type: video or image
        const videoId = creativeJson.object_story_spec?.video_data?.video_id;
        const thumbnailUrl = creativeJson.thumbnail_url;

        if (videoId) {
          await processVideoAd(adDir, videoId, token, thumbnailUrl, warnings);
        } else {
          await processImageAd(adDir, creativeJson, warnings);
        }
      } catch (err) {
        // Per-ad catch-all: never abort the pipeline
        const msg = err instanceof Error ? err.message : String(err);
        writeJson(path.join(adDir, 'metadata.json'), { error: 'unexpected', message: msg });
        warnings.push(`Unexpected error for ad ${adId}: ${msg}`);
      }
    };

    for (let start = 0; start < inputEntries.length; start += CONCURRENCY) {
      const chunk = inputEntries.slice(start, start + CONCURRENCY);
      await Promise.all(chunk.map((entry, j) => processAd(entry, start + j)));
    }

    // Build manifest
    console.error('Building manifest...');
    const { manifest, totalFrames } = buildManifest(creativesDir, tmpDir, inputEntries);
    writeJson(path.join(tmpDir, 'manifest.json'), manifest);

    // Atomic swap with rollback: rename old → backup, rename tmp → final
    const backupDir = `${creativesDir}._bak_${process.pid}`;
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* stale backup */ }
    const hadExisting = fs.existsSync(creativesDir);
    if (hadExisting) {
      fs.renameSync(creativesDir, backupDir);
    }
    try {
      fs.renameSync(tmpDir, creativesDir);
    } catch (swapErr) {
      // Rollback: restore backup if we moved it
      if (hadExisting) {
        try { fs.renameSync(backupDir, creativesDir); } catch { /* best-effort rollback */ }
      }
      throw swapErr;
    }
    // Swap succeeded — mark backup safe to delete
    backupSafeToDelete = true;
    if (hadExisting) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* non-critical */ }
    }

    console.error(`Creative artifact extraction complete. Files in ${creativesDir}/`);

    return {
      creatives_dir: creativesDir,
      total_ads: manifest.length,
      total_frames: totalFrames,
      manifest,
      warnings,
    };
  } finally {
    // Clean up temp dir if still present (error path)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* may already be renamed */ }
    // Only clean backup if swap succeeded — if rollback failed, backup is the only intact copy
    if (backupSafeToDelete) {
      try { fs.rmSync(`${creativesDir}._bak_${process.pid}`, { recursive: true, force: true }); } catch { /* may not exist */ }
    }
    if (oldUmask !== undefined) try { process.umask(oldUmask); } catch { /* worker thread */ }
  }
}
