import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock http module
vi.mock('../../lib/http.js', () => ({
  graphRequestWithRetry: vi.fn(),
  paginateAll: vi.fn(),
}));

// Mock auth module
vi.mock('../../auth.js', () => ({
  resolveAccessToken: vi.fn(() => 'test-token-123'),
  requireAccessToken: vi.fn(() => 'test-token-123'),
  requireAccountId: vi.fn(() => 'act_123'),
}));

// Mock child_process for ffmpeg/ffprobe
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// Mock pull module for run() tests
vi.mock('../../intel/pull.js', () => ({
  pull: vi.fn(),
}));

import { analyzeCreatives, sanitizeAdId, computeOrientation } from '../../intel/creatives.js';
import { run, hasFfmpeg, _resetFfmpegCache } from '../../intel/run.js';
import { pull } from '../../intel/pull.js';
import { graphRequestWithRetry } from '../../lib/http.js';
import { resolveAccessToken } from '../../auth.js';
import { execFileSync } from 'node:child_process';
import type { CreativeMediaEntry } from '../../intel/types.js';

const mockGraphRequest = vi.mocked(graphRequestWithRetry);
const mockResolveToken = vi.mocked(resolveAccessToken);
const mockExecFileSync = vi.mocked(execFileSync);
const mockPull = vi.mocked(pull);

let tmpDir: string;
let dataDir: string;
let creativesDir: string;

// ─── Factory functions ──────────────────────────────────────────

function makeMediaEntry(overrides: Partial<CreativeMediaEntry> = {}): CreativeMediaEntry {
  return {
    ad_id: 'a1',
    ad_name: 'Test Ad 1',
    objective: 'OUTCOME_SALES',
    rank: 'winner',
    primary_metric_name: 'roas',
    primary_metric_value: 2.5,
    spend: 100,
    creative_image_url: 'https://cdn.example.com/img.jpg',
    creative_thumbnail_url: 'https://cdn.example.com/thumb.jpg',
    ...overrides,
  };
}

function makeCreativesMaster(entries: Array<{ id: string; creative_id: string }> = [{ id: 'a1', creative_id: 'cr1' }]) {
  return { data: entries.map(e => ({ ...e, name: `Ad ${e.id}` })) };
}

function makeCreativeApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    thumbnail_url: 'https://cdn.example.com/thumb.jpg',
    image_url: 'https://cdn.example.com/img.jpg',
    object_story_spec: {},
    ...overrides,
  };
}

function makeVideoCreativeApiResponse(videoId = 'vid1') {
  return makeCreativeApiResponse({
    object_story_spec: { video_data: { video_id: videoId } },
  });
}

function makeVideoApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    source: 'https://cdn.example.com/video.mp4',
    length: 15,
    ...overrides,
  };
}

function makeFfprobeVideoOutput(overrides: { duration?: string; width?: number; height?: number } = {}) {
  return JSON.stringify({
    format: { duration: overrides.duration ?? '15.0' },
    streams: [{
      width: overrides.width ?? 1920,
      height: overrides.height ?? 1080,
      display_aspect_ratio: '16:9',
      codec_name: 'h264',
    }],
  });
}

function makeFfprobeImageOutput(overrides: { width?: number; height?: number } = {}) {
  return JSON.stringify({
    streams: [{
      width: overrides.width ?? 1080,
      height: overrides.height ?? 1080,
    }],
  });
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Test setup ─────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatives-test-'));
  // dataDir is inside a parent so that creativesDir = path.join(path.dirname(dataDir), 'creatives')
  // becomes tmpDir/creatives
  dataDir = path.join(tmpDir, 'data');
  creativesDir = path.join(tmpDir, 'creatives');
  fs.mkdirSync(dataDir, { recursive: true });
  vi.clearAllMocks();
  mockResolveToken.mockReturnValue('test-token-123');

  // Suppress console output during tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── Mock fetch for media downloads ─────────────────────────────

function mockFetchSuccess(content = Buffer.from('fake-binary-data')) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(content));
      controller.close();
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: stream,
  }));
}

function mockFetchFailure(status = 404) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    body: null,
  }));
}

// ─── Helper tests ───────────────────────────────────────────────

describe('sanitizeAdId', () => {
  it('strips special characters', () => {
    expect(sanitizeAdId('ad!@#$%^&*()123')).toBe('ad123');
  });

  it('preserves alphanumeric, underscore, and dash', () => {
    expect(sanitizeAdId('ad_name-123')).toBe('ad_name-123');
  });

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeAdId(long)).toHaveLength(64);
  });

  it('handles empty string', () => {
    expect(sanitizeAdId('')).toBe('');
  });
});

describe('computeOrientation', () => {
  it('returns landscape for wide images', () => {
    expect(computeOrientation(1920, 1080)).toBe('landscape');
  });

  it('returns portrait for tall images', () => {
    expect(computeOrientation(1080, 1920)).toBe('portrait');
  });

  it('returns square for equal dimensions', () => {
    expect(computeOrientation(1080, 1080)).toBe('square');
  });

  it('returns square at the boundary (ratio exactly 1.2)', () => {
    // 1200/1000 = 1.2, not > 1.2
    expect(computeOrientation(1200, 1000)).toBe('square');
  });

  it('returns landscape just above 1.2', () => {
    expect(computeOrientation(1201, 1000)).toBe('landscape');
  });

  it('returns square at the lower boundary (h == w * 1.2)', () => {
    // h = w * 1.2 exactly: not > 1.2, so square
    expect(computeOrientation(1000, 1200)).toBe('square');
  });

  it('returns portrait just past the lower boundary', () => {
    // h > w * 1.2: portrait
    expect(computeOrientation(1000, 1201)).toBe('portrait');
  });

  it('returns square for zero dimensions', () => {
    expect(computeOrientation(0, 0)).toBe('square');
  });
});

// ─── analyzeCreatives tests ─────────────────────────────────────

describe('analyzeCreatives', () => {
  function setupImageMocks() {
    mockGraphRequest.mockResolvedValue(makeCreativeApiResponse());
    mockFetchSuccess();
    mockExecFileSync.mockImplementation((cmd: unknown) => {
      if (cmd === 'ffprobe') {
        return Buffer.from(makeFfprobeImageOutput());
      }
      return Buffer.from('');
    });
  }

  function setupVideoMocks() {
    mockGraphRequest.mockImplementation(async (pathArg: string) => {
      if (pathArg.includes('/cr')) {
        return makeVideoCreativeApiResponse();
      }
      // Video details
      return makeVideoApiResponse();
    });
    mockFetchSuccess();
    mockExecFileSync.mockImplementation((cmd: unknown) => {
      if (cmd === 'ffprobe') {
        return Buffer.from(makeFfprobeVideoOutput());
      }
      return Buffer.from('');
    });
  }

  describe('image path', () => {
    it('processes an image ad and writes metadata + manifest', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());
      setupImageMocks();

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.total_ads).toBe(1);
      expect(result.warnings).toHaveLength(0);
      expect(result.creatives_dir).toBe(creativesDir);

      // Check manifest
      expect(result.manifest).toHaveLength(1);
      expect(result.manifest[0].ad_id).toBe('a1');
      expect(result.manifest[0].media_type).toBe('image');
      expect(result.manifest[0].orientation).toBe('square');
      expect(result.manifest[0].artifacts_dir).toBe(path.join(creativesDir, 'a1'));

      // Check files on disk
      const metaPath = path.join(creativesDir, 'a1', 'metadata.json');
      expect(fs.existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(meta.type).toBe('image');
      expect(meta.width).toBe(1080);
      expect(meta.height).toBe(1080);

      // Check manifest.json on disk
      const manifestPath = path.join(creativesDir, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);
    });

    it('uses thumbnail_url first, falls back to image_url', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      mockGraphRequest.mockResolvedValue(makeCreativeApiResponse({
        thumbnail_url: 'https://cdn.example.com/thumb-preferred.jpg',
        image_url: 'https://cdn.example.com/img-fallback.jpg',
      }));
      mockFetchSuccess();
      mockExecFileSync.mockReturnValue(Buffer.from(makeFfprobeImageOutput()));

      await analyzeCreatives({ inputFile, dataDir });

      const fetchMock = vi.mocked(globalThis.fetch);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://cdn.example.com/thumb-preferred.jpg',
        expect.anything(),
      );
    });
  });

  describe('video path', () => {
    it('processes a video ad with transcoding and frame extraction', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());
      setupVideoMocks();

      // Pre-create frame files that ffmpeg would produce
      // (execFileSync mock doesn't actually write files)
      const hookExecFileSync = mockExecFileSync.mockImplementation((cmd: unknown, args?: unknown) => {
        if (cmd === 'ffprobe') {
          return Buffer.from(makeFfprobeVideoOutput());
        }
        if (cmd === 'ffmpeg') {
          const argsArr = args as string[];
          // Simulate frame extraction by creating frame files
          const framePattern = argsArr?.find((a: string) => a.includes('frame_%02d'));
          if (framePattern) {
            const dir = path.dirname(framePattern);
            for (let i = 1; i <= 6; i++) {
              fs.writeFileSync(path.join(dir, `frame_${String(i).padStart(2, '0')}.png`), 'fake');
            }
            return Buffer.from('');
          }
          // Simulate last frame extraction
          const lastFrame = argsArr?.find((a: string) => a.includes('frame_last'));
          if (lastFrame) {
            fs.writeFileSync(lastFrame, 'fake');
            return Buffer.from('');
          }
          // Transcode — create the output file
          const videoOut = argsArr?.find((a: string) => a.endsWith('_video.mp4'));
          if (videoOut) {
            fs.writeFileSync(videoOut, 'fake-video');
          }
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.total_ads).toBe(1);
      expect(result.manifest[0].media_type).toBe('video');
      expect(result.manifest[0].duration).toBe(15);
      expect(result.manifest[0].orientation).toBe('landscape');
      expect(result.manifest[0].frame_count).toBe(7); // 6 evenly-spaced + 1 last

      // Verify ffmpeg was called for transcoding (cmd, argsArray)
      const calls = hookExecFileSync.mock.calls;
      expect(calls.some(c => c[0] === 'ffmpeg' && (c[1] as string[])?.includes('scale=480:-1'))).toBe(true);
      // Verify frame extraction
      expect(calls.some(c => c[0] === 'ffmpeg' && (c[1] as string[])?.some((a: string) => a.startsWith('fps=')))).toBe(true);
      // Verify last frame extraction
      expect(calls.some(c => c[0] === 'ffmpeg' && (c[1] as string[])?.includes('-sseof'))).toBe(true);
    });
  });

  describe('error handling', () => {
    it('continues when creative_id is missing', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry({ ad_id: 'unknown_ad' })]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster()); // only has 'a1'

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.warnings).toContainEqual(expect.stringContaining('No creative_id'));
      // Ad directory should have error metadata
      const metaPath = path.join(creativesDir, 'unknown_ad', 'metadata.json');
      expect(fs.existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(meta.error).toBe('no_creative_id');
    });

    it('continues when API returns an error', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      mockGraphRequest.mockRejectedValue(new Error('Rate limited'));

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.warnings).toContainEqual(expect.stringContaining('API error'));
      const meta = JSON.parse(fs.readFileSync(path.join(creativesDir, 'a1', 'metadata.json'), 'utf8'));
      expect(meta.error).toBe('api_error');
    });

    it('continues when image download fails', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      mockGraphRequest.mockResolvedValue(makeCreativeApiResponse());
      mockFetchFailure(404);

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.warnings).toContainEqual(expect.stringContaining('download failed'));
    });

    it('continues when no media URL found', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      mockGraphRequest.mockResolvedValue(makeCreativeApiResponse({
        thumbnail_url: undefined,
        image_url: undefined,
      }));

      await analyzeCreatives({ inputFile, dataDir });

      const meta = JSON.parse(fs.readFileSync(path.join(creativesDir, 'a1', 'metadata.json'), 'utf8'));
      expect(meta.error).toBe('no_media_url');
    });

    it('handles video with no source URL — falls back to thumbnail', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      mockGraphRequest.mockImplementation(async (pathArg: string) => {
        if (pathArg.includes('/cr')) {
          return makeVideoCreativeApiResponse();
        }
        return makeVideoApiResponse({ source: undefined });
      });
      mockFetchSuccess();

      await analyzeCreatives({ inputFile, dataDir });

      const meta = JSON.parse(fs.readFileSync(path.join(creativesDir, 'a1', 'metadata.json'), 'utf8'));
      expect(meta.error).toBe('no_source_url');
      expect(meta.fallback).toBe('thumbnail');
    });

    it('processes multiple ads — one failure does not abort others', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [
        makeMediaEntry({ ad_id: 'a1', ad_name: 'Good Ad' }),
        makeMediaEntry({ ad_id: 'a2', ad_name: 'Bad Ad' }),
        makeMediaEntry({ ad_id: 'a3', ad_name: 'Also Good' }),
      ]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster([
        { id: 'a1', creative_id: 'cr1' },
        { id: 'a2', creative_id: 'cr2' },
        { id: 'a3', creative_id: 'cr3' },
      ]));

      let callCount = 0;
      mockGraphRequest.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('API error for ad 2');
        }
        return makeCreativeApiResponse();
      });
      mockFetchSuccess();
      mockExecFileSync.mockReturnValue(Buffer.from(makeFfprobeImageOutput()));

      const result = await analyzeCreatives({ inputFile, dataDir });

      // All 3 ads processed (2 successful, 1 error)
      expect(result.manifest).toHaveLength(3);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('atomic swap', () => {
    it('replaces existing creatives directory', async () => {
      // Create an old creatives directory
      fs.mkdirSync(creativesDir, { recursive: true });
      fs.writeFileSync(path.join(creativesDir, 'old-file.txt'), 'old');

      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());
      setupImageMocks();

      await analyzeCreatives({ inputFile, dataDir });

      // Old file should be gone
      expect(fs.existsSync(path.join(creativesDir, 'old-file.txt'))).toBe(false);
      // New files should exist
      expect(fs.existsSync(path.join(creativesDir, 'manifest.json'))).toBe(true);
    });

    it('cleans up temp directory on error', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, 'not valid json');

      try {
        await analyzeCreatives({ inputFile, dataDir });
      } catch {
        // expected
      }

      // No temp directories should remain
      const entries = fs.readdirSync(tmpDir);
      expect(entries.every(e => !e.includes('._tmp_'))).toBe(true);
    });
  });

  describe('manifest', () => {
    it('preserves input file order in manifest', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [
        makeMediaEntry({ ad_id: 'z_last', ad_name: 'Z Ad' }),
        makeMediaEntry({ ad_id: 'a_first', ad_name: 'A Ad' }),
        makeMediaEntry({ ad_id: 'm_middle', ad_name: 'M Ad' }),
      ]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster([
        { id: 'z_last', creative_id: 'cr1' },
        { id: 'a_first', creative_id: 'cr2' },
        { id: 'm_middle', creative_id: 'cr3' },
      ]));
      setupImageMocks();

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.manifest.map(m => m.ad_id)).toEqual(['z_last', 'a_first', 'm_middle']);
    });

    it('includes roas from primary_metric_value when metric is roas', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry({ primary_metric_name: 'roas', primary_metric_value: 3.5 })]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());
      setupImageMocks();

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.manifest[0].roas).toBe(3.5);
      expect(result.manifest[0].cpa).toBe(0);
    });

    it('uses final creativesDir for artifacts_dir, not temp path', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());
      setupImageMocks();

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.manifest[0].artifacts_dir).toBe(path.join(creativesDir, 'a1'));
      expect(result.manifest[0].artifacts_dir).not.toContain('._tmp_');
    });
  });

  describe('edge cases', () => {
    it('returns empty result for empty input array', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, []);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.total_ads).toBe(0);
      expect(result.manifest).toHaveLength(0);
    });

    it('throws if input file does not exist', async () => {
      await expect(analyzeCreatives({
        inputFile: path.join(tmpDir, 'nonexistent.json'),
        dataDir,
      })).rejects.toThrow('Input file not found');
    });

    it('throws if creatives-master.json does not exist', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);

      await expect(analyzeCreatives({ inputFile, dataDir })).rejects.toThrow('creatives-master.json not found');
    });

    it('throws without an access token', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());
      mockResolveToken.mockReturnValue(undefined as unknown as string);

      await expect(analyzeCreatives({ inputFile, dataDir })).rejects.toThrow('No access token');
    });
  });

  describe('video API failure → thumbnail fallback', () => {
    it('falls back to thumbnail when video API throws', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      mockGraphRequest.mockImplementation(async (pathArg: string) => {
        if (pathArg.includes('/cr')) {
          return makeVideoCreativeApiResponse();
        }
        // Video details API fails
        throw new Error('Video API unavailable');
      });
      mockFetchSuccess();
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.warnings.some(w => w.includes('Video API error'))).toBe(true);
      // Should have thumbnail fallback, not just an error return
      const metaPath = path.join(creativesDir, 'a1', 'metadata.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(meta.error).toBe('video_api_error');
      expect(meta.fallback).toBe('thumbnail');
    });

    it('writes error without fallback when no thumbnail_url', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      mockGraphRequest.mockImplementation(async (pathArg: string) => {
        if (pathArg.includes('/cr')) {
          // Return video creative with NO thumbnail_url
          return {
            object_story_spec: { video_data: { video_id: 'v_001' } },
          };
        }
        throw new Error('Video API unavailable');
      });
      mockFetchSuccess();
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      await analyzeCreatives({ inputFile, dataDir });

      const metaPath = path.join(creativesDir, 'a1', 'metadata.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      expect(meta.error).toBe('video_api_error');
      expect(meta.fallback).toBeUndefined();
    });
  });

  describe('atomic swap with backup', () => {
    it('cleans up backup directory after successful swap', async () => {
      // Create an old creatives directory to trigger the backup path
      fs.mkdirSync(creativesDir, { recursive: true });
      fs.writeFileSync(path.join(creativesDir, 'old-file.txt'), 'old');

      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());
      setupImageMocks();

      await analyzeCreatives({ inputFile, dataDir });

      // Old dir replaced, new content present
      expect(fs.existsSync(path.join(creativesDir, 'old-file.txt'))).toBe(false);
      expect(fs.existsSync(path.join(creativesDir, 'manifest.json'))).toBe(true);
      // Backup directory should be cleaned up
      const parent = path.dirname(creativesDir);
      const entries = fs.readdirSync(parent);
      expect(entries.some(e => e.includes('._bak_'))).toBe(false);
    });
  });

  describe('transcode failure', () => {
    it('uses raw file when ffmpeg transcode fails', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [makeMediaEntry()]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster());

      mockGraphRequest.mockImplementation(async (pathArg: string) => {
        if (pathArg.includes('/cr')) {
          return makeVideoCreativeApiResponse();
        }
        return makeVideoApiResponse();
      });
      mockFetchSuccess();

      mockExecFileSync.mockImplementation((cmd: unknown) => {
        if (cmd === 'ffprobe') {
          return Buffer.from(makeFfprobeVideoOutput());
        }
        if (cmd === 'ffmpeg') {
          throw new Error('ffmpeg transcode failed');
        }
        return Buffer.from('');
      });

      const result = await analyzeCreatives({ inputFile, dataDir });

      // Should complete with a warning about transcode failure
      expect(result.warnings.some(w => w.includes('transcode failed'))).toBe(true);
      // Still produces a manifest entry
      expect(result.manifest).toHaveLength(1);
      expect(result.manifest[0].media_type).toBe('video');
    });
  });

  describe('multiple video ads', () => {
    it('processes multiple video ads independently', async () => {
      const inputFile = path.join(tmpDir, 'creative-media.json');
      writeJson(inputFile, [
        makeMediaEntry({ ad_id: 'vid1', ad_name: 'Video 1' }),
        makeMediaEntry({ ad_id: 'vid2', ad_name: 'Video 2' }),
      ]);
      writeJson(path.join(dataDir, 'creatives-master.json'), makeCreativesMaster([
        { id: 'vid1', creative_id: 'cr1' },
        { id: 'vid2', creative_id: 'cr2' },
      ]));

      mockGraphRequest.mockImplementation(async (pathArg: string) => {
        if (pathArg.includes('/cr')) {
          return makeVideoCreativeApiResponse();
        }
        return makeVideoApiResponse();
      });
      mockFetchSuccess();
      mockExecFileSync.mockImplementation((cmd: unknown) => {
        if (cmd === 'ffprobe') {
          return Buffer.from(makeFfprobeVideoOutput());
        }
        return Buffer.from('');
      });

      const result = await analyzeCreatives({ inputFile, dataDir });

      expect(result.total_ads).toBe(2);
      expect(result.manifest).toHaveLength(2);
      expect(result.manifest[0].ad_id).toBe('vid1');
      expect(result.manifest[1].ad_id).toBe('vid2');
      expect(result.manifest.every(m => m.media_type === 'video')).toBe(true);
    });
  });
});

// ─── run() tests ────────────────────────────────────────────────

describe('run', () => {
  const fakePullResult = {
    runDir: '/tmp/fake-run',
    pipelineStatus: {
      status: 'complete' as const,
      files_produced: ['creative-media.json'],
      files_skipped: [],
      warnings: [],
    },
    warnings: [],
  };

  beforeEach(() => {
    _resetFfmpegCache();
    mockPull.mockReset();
  });

  it('hasFfmpeg returns true when both commands succeed', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('ffmpeg version 6.0'));
    _resetFfmpegCache();
    expect(hasFfmpeg()).toBe(true);
  });

  it('hasFfmpeg returns false when ffmpeg not found', () => {
    mockExecFileSync.mockImplementation((cmd: unknown) => {
      if (cmd === 'ffmpeg') {
        throw new Error('command not found');
      }
      return Buffer.from('');
    });
    _resetFfmpegCache();
    expect(hasFfmpeg()).toBe(false);
  });

  it('returns creatives: undefined when ffmpeg is absent', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    _resetFfmpegCache();
    mockPull.mockResolvedValue(fakePullResult);

    const result = await run();

    expect(result.creatives).toBeUndefined();
    expect(result.runDir).toBe('/tmp/fake-run');
    expect(mockPull).toHaveBeenCalledOnce();
  });

  it('returns creatives: undefined when creative-media.json is missing', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from('ffmpeg version 6.0'));
    _resetFfmpegCache();
    mockPull.mockResolvedValue(fakePullResult);

    const result = await run();

    // creative-media.json doesn't exist at /tmp/fake-run/creative-media.json
    expect(result.creatives).toBeUndefined();
  });

  it('returns creatives: undefined when creative-media.json is empty array', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from('ffmpeg version 6.0'));
    _resetFfmpegCache();

    // Create a temp dir with an empty creative-media.json
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
    fs.writeFileSync(path.join(runDir, 'creative-media.json'), '[]');
    mockPull.mockResolvedValue({ ...fakePullResult, runDir });

    const result = await run();

    expect(result.creatives).toBeUndefined();
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
