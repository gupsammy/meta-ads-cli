import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { fetchInsightsAsync } from '../lib/http.js';
import { resolveAccessToken } from '../auth.js';
import { AD_INSIGHT_FIELDS, resolveIntelAccountId, fetchAdCreatives, acquireLock, releaseLock } from './pull.js';
import { analyzeCreatives } from './creatives.js';
import { hasFfmpeg } from './run.js';
import type { CreativeMediaEntry } from './types.js';

export interface FetchDailyOptions {
  since: string;
  until: string;
  dataDir?: string;
  configPath?: string;
  accessToken?: string;
  /** Also retain each current ad's source video (audio+motion) for tagging. */
  keepVideo?: boolean;
}

export interface FetchDailyResult {
  run_dir: string;
  account_id: string;
  since: string;
  until: string;
  rows: number;
  file: string;
  /** Present only when --keep-video ran and the video step was not skipped. */
  creatives?: {
    total_ads: number;
    total_frames: number;
    videos_retained: number;
    /** At-cap truncation notice + per-ad extraction failures, if any. */
    warnings?: string[];
  };
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * --keep-video companion to the metrics pull: snapshot the account's CURRENT ad
 * creatives and retain each source video (audio+motion) so the skill can tag it.
 *
 * Window-independent by design: Meta's video source URLs expire for deleted ads,
 * so only currently-live creatives can be fetched — the [since, until] window
 * governs metrics, not which videos exist. Reuses analyzeCreatives wholesale, so
 * videos land in the shared ~/.meta-ads-intel/creatives/<ad_id>/video.mp4, byte-
 * identical to `intel run --keep-video`.
 *
 * SNAPSHOT, not archive: analyzeCreatives atomically REPLACES the whole shared
 * creatives dir with this call's ad set (same as `intel run --keep-video`), so a
 * later run evicts artifacts for ads that have since left "current". That is fine
 * for creative-signal — the skill tags each video into SQLite (by asset_hash)
 * right after this fetch, so the durable artifact is the tag, not the file.
 *
 * Best-effort: ffmpeg missing or zero creatives → warn and skip. The metrics pull
 * has already succeeded by the time this runs; the optional video step never fails
 * the job. Returns undefined when skipped.
 */
async function retainCreativeVideos(
  accountId: string,
  token: string,
  dataDir: string,
  runDir: string,
): Promise<FetchDailyResult['creatives']> {
  if (!hasFfmpeg()) {
    console.error('ffmpeg/ffprobe not installed — skipping --keep-video retention.');
    console.error('  Install with: brew install ffmpeg');
    return undefined;
  }

  // `warnings` receives the at-cap (PULL_LIMIT) truncation notice: for accounts
  // with more current ads than the cap, only a subset is retained — surface it
  // rather than silently dropping the tail (same signal pull() emits).
  const warnings: string[] = [];
  const creatives = await fetchAdCreatives(accountId, token, warnings);
  if (creatives.length === 0) {
    console.error('No current ad creatives found — skipping --keep-video retention.');
    return undefined;
  }
  for (const w of warnings) console.error(`  warning: ${w}`);

  // analyzeCreatives requires two inputs: creatives-master.json (the ad_id →
  // creative_id lookup, at the standard <dataDir> path intel run also writes) and
  // a creative-media.json list of ads to process (written into this window's run
  // dir). rank/metric fields are display-only in a raw daily pull — placeholders.
  writeJson(path.join(dataDir, 'creatives-master.json'), { data: creatives });
  const media: CreativeMediaEntry[] = creatives.map(c => ({
    ad_id: c.id,
    ad_name: c.name ?? null,
    objective: '',
    rank: 'winner',
    primary_metric_name: '',
    primary_metric_value: 0,
    spend: 0,
    creative_image_url: c.creative_image_url,
    creative_thumbnail_url: c.creative_thumbnail_url,
  }));
  const mediaFile = path.join(runDir, 'creative-media.json');
  writeJson(mediaFile, media);

  console.error('');
  console.error('=== Retaining source videos (--keep-video) ===');
  const res = await analyzeCreatives({
    inputFile: mediaFile,
    dataDir,
    accessToken: token,
    keepVideo: true,
  });

  const allWarnings = [...warnings, ...res.warnings];
  return {
    total_ads: res.total_ads,
    total_frames: res.total_frames,
    videos_retained: res.manifest.filter(m => Boolean(m.video_path)).length,
    ...(allWarnings.length ? { warnings: allWarnings } : {}),
  };
}

/**
 * Thin, scriptable ad×daily metrics pull for an explicit [since, until] window.
 * The creative-signal data layer calls this for both backfill chunks and
 * incremental catch-up. Ad-level, time_increment=1, async report — the same
 * path `intel run` uses for ads-daily.json, but driven by an explicit time_range
 * instead of a date preset, and reusing AD_INSIGHT_FIELDS so the retention
 * fields (hook/hold-rate) come along.
 *
 * NO effective_status filter (unlike `intel run`): Meta's insights returns rows
 * only for ads that actually delivered in the window, so the result is naturally
 * "every ad active at any point in [since, until]" — including ads now paused,
 * which is exactly what backfill needs. The async report API absorbs the volume.
 *
 * Dates are validated at the CLI boundary (both required, YYYY-MM-DD, since ≤ until).
 */
export async function fetchDaily(options: FetchDailyOptions): Promise<FetchDailyResult> {
  const { since, until } = options;
  const dataDir = options.dataDir
    ?? process.env['META_ADS_DATA_DIR']
    ?? path.join(homedir(), '.meta-ads-intel', 'data');
  const skillConfigPath = options.configPath ?? path.join(homedir(), '.meta-ads-intel', 'config.json');

  // Ad spend data is sensitive — restrict file permissions (matches pull()).
  let oldUmask: number | undefined;
  try { oldUmask = process.umask(0o077); } catch { /* worker thread */ }
  let lockDir: string | undefined;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Same .pull-lock as `intel run`: a scheduled fetch-daily must not race a
    // concurrent pull on the shared dataDir / creatives/ dir.
    lockDir = acquireLock(dataDir);

    const { accountId } = resolveIntelAccountId(skillConfigPath);
    const token = options.accessToken ?? resolveAccessToken();
    if (!token) {
      throw new Error(
        'No access token found.\n' +
        '  Provide via --access-token, META_ADS_ACCESS_TOKEN env, or run: meta-ads auth login',
      );
    }

    // Run dir namespaced under daily/ and keyed by the window: distinct backfill
    // chunks get distinct dirs; re-fetching the same window (the trailing-7d
    // catch-up) overwrites idempotently.
    const runDir = path.join(dataDir, 'daily', `${since}_${until}`);
    fs.mkdirSync(runDir, { recursive: true });

    console.error(`Fetching ad×daily insights for ${accountId} [${since} → ${until}]...`);
    // No row cap (limit omitted): paginateAll follows every cursor to completion.
    // A total cap would SILENTLY truncate — ad×day rows easily exceed a few
    // hundred, and this is the creative-signal store's source of truth. Volume is
    // bounded instead by the caller chunking backfill into ~30-day windows.
    const result = await fetchInsightsAsync<Record<string, unknown>>(
      `/${accountId}/insights`,
      token,
      {
        params: {
          fields: AD_INSIGHT_FIELDS,
          level: 'ad',
          time_increment: '1',
          time_range: JSON.stringify({ since, until }),
        },
      },
    );

    const file = path.join(runDir, 'ads-daily.json');
    writeJson(file, { data: result.data });

    // Optional: retain current source videos for tagging. Runs AFTER metrics are
    // safely on disk so a video-step failure never costs the metrics pull — any
    // throw from the creatives fetch or the dir swap is downgraded to a warning
    // and the metrics result is still returned (creatives omitted).
    let creatives: FetchDailyResult['creatives'];
    if (options.keepVideo) {
      try {
        creatives = await retainCreativeVideos(accountId, token, dataDir, runDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`warning: --keep-video retention failed, metrics pull unaffected: ${msg}`);
        creatives = undefined;
      }
    }

    return {
      run_dir: runDir,
      account_id: accountId,
      since,
      until,
      rows: result.data.length,
      file,
      ...(creatives ? { creatives } : {}),
    };
  } finally {
    if (lockDir) releaseLock(lockDir);
    if (oldUmask !== undefined) { try { process.umask(oldUmask); } catch { /* ok */ } }
  }
}
