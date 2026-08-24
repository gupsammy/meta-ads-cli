import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock http — fetchInsightsAsync must not hit the network. paginateAll /
// graphRequestWithRetry are also mocked because pull.js (imported for
// AD_INSIGHT_FIELDS / resolveIntelAccountId) pulls them in at module load.
vi.mock('../../lib/http.js', () => ({
  fetchInsightsAsync: vi.fn(),
  paginateAll: vi.fn(),
  graphRequestWithRetry: vi.fn(),
}));

import { fetchDaily } from '../../intel/fetch-daily.js';
import { fetchInsightsAsync } from '../../lib/http.js';
import type { PaginatedResult } from '../../lib/http.js';

const mockFetchAsync = vi.mocked(fetchInsightsAsync);

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

  it('resolves account from META_ADS_ACCOUNT_ID and normalizes the act_ prefix', async () => {
    process.env['META_ADS_ACCOUNT_ID'] = '999888'; // no act_ prefix
    mockRows();

    const result = await fetchDaily({ since: '2026-04-01', until: '2026-04-02', dataDir, accessToken: 'tok' });

    expect(result.account_id).toBe('act_999888');
    expect(mockFetchAsync.mock.calls[0][0]).toBe('/act_999888/insights');
  });
});
