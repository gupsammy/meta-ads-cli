import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock http — fetchInsightsAsync must not hit the network. paginateAll (used by
// fetchAdCreatives for --keep-video) / graphRequestWithRetry are also mocked
// because pull.js (imported for AD_INSIGHT_FIELDS / resolveIntelAccountId /
// fetchAdCreatives) pulls them in at module load.
vi.mock('../../lib/http.js', () => ({
  fetchInsightsAsync: vi.fn(),
  paginateAll: vi.fn(),
  graphRequestWithRetry: vi.fn(),
}));

// The --keep-video path reuses the visual pipeline; mock its two seams so no
// ffmpeg/network is touched: hasFfmpeg (run.js) and analyzeCreatives (creatives.js).
vi.mock('../../intel/creatives.js', () => ({ analyzeCreatives: vi.fn() }));
vi.mock('../../intel/run.js', () => ({ hasFfmpeg: vi.fn(() => true) }));

import { fetchDaily } from '../../intel/fetch-daily.js';
import { fetchInsightsAsync, paginateAll } from '../../lib/http.js';
import { analyzeCreatives } from '../../intel/creatives.js';
import { hasFfmpeg } from '../../intel/run.js';
import type { PaginatedResult } from '../../lib/http.js';

const mockFetchAsync = vi.mocked(fetchInsightsAsync);
const mockPaginate = vi.mocked(paginateAll);
const mockAnalyze = vi.mocked(analyzeCreatives);
const mockHasFfmpeg = vi.mocked(hasFfmpeg);

/** Seed the current-creatives snapshot that fetchAdCreatives pulls via paginateAll. */
function mockCreatives(rows: Array<Record<string, unknown>>) {
  mockPaginate.mockResolvedValue({ data: rows, has_more: false } as PaginatedResult<Record<string, unknown>>);
}

let tmpDir: string;
let dataDir: string;

function mockRows(rows: Array<Record<string, unknown>> = [{ ad_id: 'a1', date_start: '2026-01-01' }]) {
  const result: PaginatedResult<Record<string, unknown>> = { data: rows, has_more: false };
  mockFetchAsync.mockResolvedValue(result);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchdaily-test-'));
  dataDir = path.join(tmpDir, 'data');
  process.env['META_ADS_ACCOUNT_ID'] = 'act_test';
  vi.clearAllMocks();
  mockHasFfmpeg.mockReturnValue(true); // cleared above; keep-video path needs ffmpeg
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['META_ADS_ACCOUNT_ID'];
  vi.restoreAllMocks();
});

describe('fetchDaily', () => {
  it('requests an ad×daily async report with time_range and no status filter', async () => {
    mockRows();

    await fetchDaily({ since: '2026-01-01', until: '2026-01-31', dataDir, accessToken: 'tok' });

    expect(mockFetchAsync).toHaveBeenCalledTimes(1);
    const [pathArg, token, opts] = mockFetchAsync.mock.calls[0];
    expect(pathArg).toBe('/act_test/insights');
    expect(token).toBe('tok');
    expect(opts?.params?.level).toBe('ad');
    expect(opts?.params?.time_increment).toBe('1');
    expect(opts?.params?.time_range).toBe(JSON.stringify({ since: '2026-01-01', until: '2026-01-31' }));
    // Delivery-based backfill: NO effective_status filter (ads active at any point).
    expect(opts?.params?.filtering).toBeUndefined();
    // Retention fields ride along via the shared AD_INSIGHT_FIELDS.
    expect(opts?.params?.fields).toContain('video_thruplay_watched_actions');
    expect(opts?.params?.fields).toContain('video_p100_watched_actions');
    // No row cap passed → paginateAll fetches every page (no silent backfill
    // truncation). The 4th positional arg (limit) must be undefined.
    expect(mockFetchAsync.mock.calls[0][3]).toBeUndefined();
  });

  it('writes ads-daily.json to a window-keyed run dir and returns metadata', async () => {
    mockRows([{ ad_id: 'a1' }, { ad_id: 'a2' }]);

    const result = await fetchDaily({ since: '2026-02-01', until: '2026-02-07', dataDir, accessToken: 'tok' });

    const expectedDir = path.join(dataDir, 'daily', '2026-02-01_2026-02-07');
    expect(result.run_dir).toBe(expectedDir);
    expect(result.account_id).toBe('act_test');
    expect(result.since).toBe('2026-02-01');
    expect(result.until).toBe('2026-02-07');
    expect(result.rows).toBe(2);
    expect(result.file).toBe(path.join(expectedDir, 'ads-daily.json'));

    const written = JSON.parse(fs.readFileSync(result.file, 'utf8'));
    expect(written.data).toHaveLength(2);
    expect(written.data[0].ad_id).toBe('a1');
  });

  it('re-fetching the same window overwrites idempotently', async () => {
    mockRows([{ ad_id: 'a1' }]);
    await fetchDaily({ since: '2026-03-01', until: '2026-03-07', dataDir, accessToken: 'tok' });

    mockRows([{ ad_id: 'a1' }, { ad_id: 'a2' }, { ad_id: 'a3' }]);
    const result = await fetchDaily({ since: '2026-03-01', until: '2026-03-07', dataDir, accessToken: 'tok' });

    expect(result.rows).toBe(3);
    const written = JSON.parse(fs.readFileSync(result.file, 'utf8'));
    expect(written.data).toHaveLength(3);
  });

  it('takes .pull-lock for the duration of the run and releases it after', async () => {
    mockRows();
    const lockDir = path.join(dataDir, '.pull-lock');
    mockFetchAsync.mockImplementationOnce(async () => {
      expect(fs.existsSync(lockDir)).toBe(true); // held while the report runs
      return { data: [], has_more: false };
    });
    await fetchDaily({ since: '2026-01-01', until: '2026-01-02', dataDir, accessToken: 'tok' });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('refuses to run while another pull holds .pull-lock (and leaves it in place)', async () => {
    mockRows();
    fs.mkdirSync(dataDir, { recursive: true });
    const lockDir = path.join(dataDir, '.pull-lock');
    fs.mkdirSync(lockDir);
    await expect(fetchDaily({ since: '2026-01-01', until: '2026-01-02', dataDir, accessToken: 'tok' }))
      .rejects.toThrow(/Another pull instance is running/);
    expect(mockFetchAsync).not.toHaveBeenCalled();
    expect(fs.existsSync(lockDir)).toBe(true); // not ours to release
  });

  it('resolves account from META_ADS_ACCOUNT_ID and normalizes the act_ prefix', async () => {
    process.env['META_ADS_ACCOUNT_ID'] = '999888'; // no act_ prefix
    mockRows();

    const result = await fetchDaily({ since: '2026-04-01', until: '2026-04-02', dataDir, accessToken: 'tok' });

    expect(result.account_id).toBe('act_999888');
    expect(mockFetchAsync.mock.calls[0][0]).toBe('/act_999888/insights');
  });

  describe('--keep-video', () => {
    it('snapshots current creatives and retains videos via analyzeCreatives', async () => {
      mockRows();
      mockCreatives([
        { id: 'ad1', name: 'Ad One', creative: { id: 'cr1' } },
        { id: 'ad2', name: 'Ad Two', creative: { id: 'cr2' } },
      ]);
      // Two ads processed, only one yielded a retained video.
      mockAnalyze.mockResolvedValue({
        creatives_dir: '/x/creatives',
        total_ads: 2,
        total_frames: 8,
        manifest: [
          { ad_id: 'ad1', video_path: '/x/creatives/ad1/video.mp4' },
          { ad_id: 'ad2' }, // image ad — no video_path
        ] as never,
        warnings: [],
      });

      const result = await fetchDaily({ since: '2026-05-01', until: '2026-05-07', dataDir, accessToken: 'tok', keepVideo: true });

      // analyzeCreatives invoked once with keepVideo:true and this window's media file.
      expect(mockAnalyze).toHaveBeenCalledTimes(1);
      const arg = mockAnalyze.mock.calls[0][0];
      expect(arg.keepVideo).toBe(true);
      expect(arg.dataDir).toBe(dataDir);
      expect(arg.accessToken).toBe('tok');
      expect(arg.inputFile).toBe(path.join(dataDir, 'daily', '2026-05-01_2026-05-07', 'creative-media.json'));

      // creatives-master.json (the ad_id → creative_id lookup) written at the dataDir root.
      const master = JSON.parse(fs.readFileSync(path.join(dataDir, 'creatives-master.json'), 'utf8'));
      expect(master.data).toHaveLength(2);
      expect(master.data[0]).toMatchObject({ id: 'ad1', creative_id: 'cr1' });

      // creative-media.json (the ad list to process) written in the run dir.
      const media = JSON.parse(fs.readFileSync(arg.inputFile, 'utf8'));
      expect(media).toHaveLength(2);
      expect(media[0]).toMatchObject({ ad_id: 'ad1', ad_name: 'Ad One' });

      // Summary: videos_retained counts only manifest entries with a video_path.
      expect(result.creatives).toEqual({ total_ads: 2, total_frames: 8, videos_retained: 1 });
    });

    it('does not touch the creative pipeline without --keep-video', async () => {
      mockRows();

      const result = await fetchDaily({ since: '2026-05-01', until: '2026-05-07', dataDir, accessToken: 'tok' });

      expect(mockAnalyze).not.toHaveBeenCalled();
      expect(mockPaginate).not.toHaveBeenCalled();
      expect(result.creatives).toBeUndefined();
      expect(fs.existsSync(path.join(dataDir, 'creatives-master.json'))).toBe(false);
    });

    it('skips retention (but keeps metrics) when ffmpeg is absent', async () => {
      mockRows();
      mockHasFfmpeg.mockReturnValue(false);

      const result = await fetchDaily({ since: '2026-05-01', until: '2026-05-07', dataDir, accessToken: 'tok', keepVideo: true });

      expect(mockAnalyze).not.toHaveBeenCalled();
      expect(result.creatives).toBeUndefined();
      // Metrics pull still succeeded.
      expect(fs.existsSync(result.file)).toBe(true);
    });

    it('surfaces a truncation warning when the current-creatives fetch hits the cap', async () => {
      mockRows();
      // paginateAll caps at PULL_LIMIT (500); a full page signals possible truncation.
      mockCreatives(Array.from({ length: 500 }, (_, i) => ({ id: `ad${i}`, name: `Ad ${i}`, creative: { id: `cr${i}` } })));
      mockAnalyze.mockResolvedValue({
        creatives_dir: '/x/creatives',
        total_ads: 500,
        total_frames: 0,
        manifest: [],
        warnings: ['API error for ad ad3: boom'],
      });

      const result = await fetchDaily({ since: '2026-06-01', until: '2026-06-07', dataDir, accessToken: 'tok', keepVideo: true });

      // Truncation notice + the analyzeCreatives per-ad warning both surface in the summary.
      expect(result.creatives?.warnings?.some(w => /500/.test(w))).toBe(true);
      expect(result.creatives?.warnings).toContain('API error for ad ad3: boom');
    });

    it('returns the metrics result (no creatives) when the video step throws', async () => {
      mockRows();
      mockCreatives([{ id: 'ad1', name: 'A', creative: { id: 'c1' } }]);
      mockAnalyze.mockRejectedValue(new Error('rename EBUSY: creatives swap failed'));

      const result = await fetchDaily({ since: '2026-05-01', until: '2026-05-02', dataDir, keepVideo: true, accessToken: 'tok' });

      expect(result.rows).toBe(1);
      expect(fs.existsSync(result.file)).toBe(true);
      expect(result.creatives).toBeUndefined();
      expect(fs.existsSync(path.join(dataDir, '.pull-lock'))).toBe(false); // lock still released
    });

    it('skips retention (but keeps metrics) when the account has no current creatives', async () => {
      mockRows();
      mockCreatives([]);

      const result = await fetchDaily({ since: '2026-05-01', until: '2026-05-07', dataDir, accessToken: 'tok', keepVideo: true });

      expect(mockAnalyze).not.toHaveBeenCalled();
      expect(result.creatives).toBeUndefined();
      expect(fs.existsSync(result.file)).toBe(true);
    });
  });
});
