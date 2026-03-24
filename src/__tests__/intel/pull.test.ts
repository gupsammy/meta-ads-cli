import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock http module before importing pull
vi.mock('../../lib/http.js', () => ({
  paginateAll: vi.fn(),
  graphRequestWithRetry: vi.fn(),
}));

// Mock auth module — resolveAccessToken returns a test token by default
vi.mock('../../auth.js', () => ({
  resolveAccessToken: vi.fn(() => 'test-token-123'),
}));

import { pull } from '../../intel/pull.js';
import { paginateAll, graphRequestWithRetry } from '../../lib/http.js';
import { resolveAccessToken } from '../../auth.js';
import * as summarizeModule from '../../intel/summarize.js';

const mockPaginateAll = vi.mocked(paginateAll);
const mockGraphRequest = vi.mocked(graphRequestWithRetry);
const mockResolveToken = vi.mocked(resolveAccessToken);

let tmpDir: string;
let dataDir: string;
let configPath: string;

/** Minimal insights row for API mock responses */
function makeInsightsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaign_id: 'c1',
    campaign_name: 'Campaign 1',
    adset_id: 'as1',
    adset_name: 'Adset 1',
    ad_id: 'a1',
    ad_name: 'Ad 1',
    spend: '100',
    impressions: '5000',
    clicks: '150',
    cpc: '0.67',
    ctr: '3.0',
    cpm: '20.10',
    frequency: '1.5',
    reach: '3333',
    actions: [{ action_type: 'omni_purchase', value: '5' }],
    action_values: [{ action_type: 'omni_purchase', value: '250' }],
    purchase_roas: [{ action_type: 'omni_purchase', value: '2.5' }],
    date_start: '2026-03-01',
    date_stop: '2026-03-14',
    ...overrides,
  };
}

/** Write a valid skill config (v2) */
function writeConfig(overrides: Record<string, unknown> = {}): void {
  const config = {
    account_id: 'act_123',
    account_name: 'Test Account',
    currency: 'USD',
    config_version: 2,
    objectives_detected: ['OUTCOME_SALES'],
    primary_objective: 'OUTCOME_SALES',
    targets: {
      OUTCOME_SALES: { cpa: 50, roas: 2.0 },
      global: { max_frequency: 5.0, min_spend: 0 },
    },
    analysis: { top_n: 15, bottom_n: 10, zero_conversion_n: 10 },
    funnel_expected_rates: {
      OUTCOME_SALES: { click_rate: 3.0, landing_rate: 70.0, add_to_cart_rate: 8.0, cart_to_checkout: 50.0, checkout_to_purchase: 60.0 },
    },
    ...overrides,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/** Set up standard mock responses for a successful pull */
function setupMocks(): void {
  mockPaginateAll.mockImplementation(async (pathArg: string, _token: string, _options?: { params?: Record<string, string> }) => {
    // Insights calls
    if (pathArg.includes('/insights')) {
      return { data: [makeInsightsRow()], has_more: false };
    }
    // Campaigns list (metadata)
    if (pathArg.includes('/campaigns')) {
      return { data: [{ id: 'c1', name: 'Campaign 1', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'CONVERSIONS' }], has_more: false };
    }
    // Ads list (creatives)
    if (pathArg.includes('/ads')) {
      return {
        data: [{
          id: 'a1',
          name: 'Ad 1',
          creative: { id: 'cr1', title: 'Title', body: 'Body text', image_url: 'https://img.jpg', thumbnail_url: 'https://thumb.jpg' },
        }],
        has_more: false,
      };
    }
    return { data: [], has_more: false };
  });

  mockGraphRequest.mockResolvedValue({
    id: 'act_123',
    name: 'Test Account',
    account_id: '123',
    account_status: 1,
    currency: 'USD',
    timezone_name: 'America/Los_Angeles',
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-test-'));
  dataDir = path.join(tmpDir, 'data');
  configPath = path.join(tmpDir, 'config.json');
  vi.clearAllMocks();

  // Re-establish default token mock after clearAllMocks
  mockResolveToken.mockReturnValue('test-token-123');

  // Set env var for account resolution
  process.env['META_ADS_ACCOUNT_ID'] = 'act_123';
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['META_ADS_ACCOUNT_ID'];
});

describe('pull', () => {
  describe('full pipeline', () => {
    it('creates all output files and returns complete status', async () => {
      writeConfig();
      setupMocks();

      const result = await pull({ dataDir, configPath });

      expect(result.pipelineStatus.status).toBe('complete');
      expect(result.runDir).toContain(dataDir);

      // Verify directory structure
      expect(fs.existsSync(path.join(result.runDir, '_raw'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, '_summaries'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, '_recent'))).toBe(true);

      // Verify raw files
      expect(fs.existsSync(path.join(result.runDir, '_raw', 'campaigns.json'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, '_raw', 'adsets.json'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, '_raw', 'ads.json'))).toBe(true);

      // Verify summaries moved out of _raw
      expect(fs.existsSync(path.join(result.runDir, '_summaries', 'campaigns-summary.json'))).toBe(true);

      // Verify analysis files
      expect(fs.existsSync(path.join(result.runDir, 'account-health.json'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, 'pipeline-status.json'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, 'trends.json'))).toBe(true);

      // Verify manifest
      expect(fs.existsSync(path.join(dataDir, 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'latest.json'))).toBe(true);
    });

    it('passes accessToken option through to API calls', async () => {
      writeConfig();
      setupMocks();
      mockResolveToken.mockReturnValue(undefined as unknown as string);

      await pull({ dataDir, configPath, accessToken: 'custom-token' });

      // All paginateAll calls should use the custom token
      for (const call of mockPaginateAll.mock.calls) {
        expect(call[1]).toBe('custom-token');
      }
    });
  });

  describe('account ID resolution', () => {
    it('resolves from META_ADS_ACCOUNT_ID env var', async () => {
      process.env['META_ADS_ACCOUNT_ID'] = 'act_999';
      writeConfig();
      setupMocks();

      await pull({ dataDir, configPath });

      // First paginateAll call path should include act_999
      expect(mockPaginateAll.mock.calls[0][0]).toContain('act_999');
    });

    it('resolves from skill config when env var absent', async () => {
      delete process.env['META_ADS_ACCOUNT_ID'];
      writeConfig({ account_id: 'act_456' });
      setupMocks();

      await pull({ dataDir, configPath });

      expect(mockPaginateAll.mock.calls[0][0]).toContain('act_456');
    });

    it('throws when no account ID found anywhere', async () => {
      delete process.env['META_ADS_ACCOUNT_ID'];
      // No skill config, no env var — and point CLI config at a non-existent dir
      // to prevent resolution from the real ~/.config/meta-ads-cli/config.json
      process.env['XDG_CONFIG_HOME'] = path.join(tmpDir, 'no-cli-config');
      setupMocks();

      try {
        await expect(pull({ dataDir, configPath })).rejects.toThrow('No account ID found');
      } finally {
        delete process.env['XDG_CONFIG_HOME'];
      }
    });

    it('prepends act_ when ID lacks prefix', async () => {
      process.env['META_ADS_ACCOUNT_ID'] = '12345';
      writeConfig();
      setupMocks();

      await pull({ dataDir, configPath });

      expect(mockPaginateAll.mock.calls[0][0]).toContain('act_12345');
    });
  });

  describe('lock management', () => {
    it('throws when lock already held', async () => {
      writeConfig();
      setupMocks();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(path.join(dataDir, '.pull-lock'));

      await expect(pull({ dataDir, configPath })).rejects.toThrow('Another pull instance is running');
    });

    it('removes stale lock (>30 min old) and proceeds', async () => {
      writeConfig();
      setupMocks();
      fs.mkdirSync(dataDir, { recursive: true });
      const lockDir = path.join(dataDir, '.pull-lock');
      fs.mkdirSync(lockDir);
      // Set mtime to 31 minutes ago
      const staleTime = new Date(Date.now() - 31 * 60 * 1000);
      fs.utimesSync(lockDir, staleTime, staleTime);

      const result = await pull({ dataDir, configPath });
      expect(result.pipelineStatus).toBeDefined();
    });

    it('releases lock on success', async () => {
      writeConfig();
      setupMocks();

      await pull({ dataDir, configPath });

      expect(fs.existsSync(path.join(dataDir, '.pull-lock'))).toBe(false);
    });

    it('releases lock on error', async () => {
      writeConfig();
      mockPaginateAll.mockRejectedValue(new Error('API failure'));
      fs.mkdirSync(dataDir, { recursive: true });

      await expect(pull({ dataDir, configPath })).rejects.toThrow('API failure');
      expect(fs.existsSync(path.join(dataDir, '.pull-lock'))).toBe(false);
    });
  });

  describe('TTL caching', () => {
    it('skips creatives pull when cache is fresh', async () => {
      writeConfig();
      setupMocks();

      // Pre-create a fresh creatives-master.json
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'creatives-master.json'),
        JSON.stringify({ data: [{ id: 'a1', name: 'Ad 1', creative_body: 'Cached', creative_title: 'Cached Title', creative_image_url: '', creative_thumbnail_url: '' }] }),
      );

      await pull({ dataDir, configPath });

      // paginateAll should NOT have been called with /ads path (only /insights and /campaigns)
      const adsCalls = mockPaginateAll.mock.calls.filter(c => c[0].includes('/ads'));
      expect(adsCalls).toHaveLength(0);
    });

    it('re-pulls creatives when cache is stale (>24h)', async () => {
      writeConfig();
      setupMocks();

      // Pre-create a stale creatives-master.json
      fs.mkdirSync(dataDir, { recursive: true });
      const stalePath = path.join(dataDir, 'creatives-master.json');
      fs.writeFileSync(stalePath, JSON.stringify({ data: [] }));
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(stalePath, staleTime, staleTime);

      await pull({ dataDir, configPath });

      const adsCalls = mockPaginateAll.mock.calls.filter(c => c[0].includes('/ads'));
      expect(adsCalls.length).toBeGreaterThan(0);
    });

    it('skips account pull when cache is fresh', async () => {
      writeConfig();
      setupMocks();

      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'account-master.json'),
        JSON.stringify({ id: 'act_123', currency: 'USD' }),
      );

      await pull({ dataDir, configPath });

      // graphRequestWithRetry should NOT have been called
      expect(mockGraphRequest).not.toHaveBeenCalled();
    });

    it('re-pulls account when cache is stale (>7 days)', async () => {
      writeConfig();
      setupMocks();

      fs.mkdirSync(dataDir, { recursive: true });
      const stalePath = path.join(dataDir, 'account-master.json');
      fs.writeFileSync(stalePath, JSON.stringify({}));
      const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(stalePath, staleTime, staleTime);

      await pull({ dataDir, configPath });

      expect(mockGraphRequest).toHaveBeenCalled();
    });
  });

  describe('recent window', () => {
    it('skips recent window when datePreset is last_7d', async () => {
      writeConfig();
      setupMocks();

      const result = await pull({ dataDir, configPath, datePreset: 'last_7d' });

      expect(fs.existsSync(path.join(result.runDir, '_recent'))).toBe(false);

      // Should have 3 insights calls (campaign/adset/ad) + 1 campaigns meta, no 4th insights call
      const insightsCalls = mockPaginateAll.mock.calls.filter(c => c[0].includes('/insights'));
      expect(insightsCalls).toHaveLength(3);
    });

    it('creates recent window when datePreset is last_14d', async () => {
      writeConfig();
      setupMocks();

      const result = await pull({ dataDir, configPath, datePreset: 'last_14d' });

      expect(fs.existsSync(path.join(result.runDir, '_recent'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, '_recent', 'campaigns-summary.json'))).toBe(true);

      // _recent_raw should be cleaned up
      expect(fs.existsSync(path.join(result.runDir, '_recent_raw'))).toBe(false);

      // Should have 4 insights calls: 3 period + 1 recent
      const insightsCalls = mockPaginateAll.mock.calls.filter(c => c[0].includes('/insights'));
      expect(insightsCalls).toHaveLength(4);
    });
  });

  describe('truncation warnings', () => {
    it('adds warning when results hit the limit', async () => {
      writeConfig();
      setupMocks();

      // Override campaign insights to return exactly 500 items
      const bigData = Array.from({ length: 500 }, (_, i) => makeInsightsRow({ campaign_id: `c${i}` }));
      mockPaginateAll.mockImplementation(async (pathArg: string) => {
        if (pathArg.includes('/insights')) {
          return { data: bigData, has_more: true };
        }
        if (pathArg.includes('/campaigns')) {
          return { data: [{ id: 'c1', name: 'Campaign 1', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'CONVERSIONS' }], has_more: false };
        }
        if (pathArg.includes('/ads')) {
          return { data: [{ id: 'a1', name: 'Ad 1', creative: { body: 'B', title: 'T' } }], has_more: false };
        }
        return { data: [], has_more: false };
      });

      const result = await pull({ dataDir, configPath });

      expect(result.warnings.some(w => w.includes('truncated'))).toBe(true);
    });
  });

  describe('config migration', () => {
    it('migrates legacy target_ctr key to ctr', async () => {
      const legacyConfig = {
        account_id: 'act_123',
        account_name: 'Test Account',
        currency: 'USD',
        config_version: 2,
        objectives_detected: ['OUTCOME_SALES', 'OUTCOME_TRAFFIC'],
        primary_objective: 'OUTCOME_SALES',
        targets: {
          OUTCOME_SALES: { cpa: 50, roas: 2.0 },
          OUTCOME_TRAFFIC: { target_ctr: 2.5 },
          OUTCOME_ENGAGEMENT: { target_engagement_rate: 5.0 },
          global: { max_frequency: 5.0, min_spend: 0 },
        },
        analysis: { top_n: 15, bottom_n: 10, zero_conversion_n: 10 },
        funnel_expected_rates: {},
      };
      fs.writeFileSync(configPath, JSON.stringify(legacyConfig, null, 2));
      setupMocks();

      await pull({ dataDir, configPath });

      const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updatedConfig.targets.OUTCOME_TRAFFIC.ctr).toBe(2.5);
      expect(updatedConfig.targets.OUTCOME_TRAFFIC.target_ctr).toBeUndefined();
      expect(updatedConfig.targets.OUTCOME_ENGAGEMENT.engagement_rate).toBe(5.0);
      expect(updatedConfig.targets.OUTCOME_ENGAGEMENT.target_engagement_rate).toBeUndefined();
    });
  });

  describe('creative flattening', () => {
    it('writes flat creative_body not nested creative.body', async () => {
      writeConfig();
      setupMocks();

      await pull({ dataDir, configPath });

      const creatives = JSON.parse(fs.readFileSync(path.join(dataDir, 'creatives-master.json'), 'utf-8'));
      expect(creatives.data[0].creative_body).toBe('Body text');
      expect(creatives.data[0].creative_title).toBe('Title');
      expect(creatives.data[0].creative_image_url).toBe('https://img.jpg');
      // Nested shape should NOT exist
      expect(creatives.data[0].creative).toBeUndefined();
    });
  });

  describe('manifest update', () => {
    it('includes all dated directories in manifest', async () => {
      writeConfig();
      setupMocks();

      // Pre-create 2 older run dirs
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(path.join(dataDir, '2026-03-20_1000'));
      fs.mkdirSync(path.join(dataDir, '2026-03-21_1400'));

      await pull({ dataDir, configPath });

      const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf-8'));
      expect(manifest.count).toBe(3); // 2 pre-existing + 1 new
      expect(manifest.entries).toContain('2026-03-20_1000');
      expect(manifest.entries).toContain('2026-03-21_1400');

      const latest = JSON.parse(fs.readFileSync(path.join(dataDir, 'latest.json'), 'utf-8'));
      // Latest should be the newest run (today's timestamp)
      expect(latest.latest).toBeDefined();
    });
  });

  describe('token resolution', () => {
    it('throws when no token available', async () => {
      writeConfig();
      setupMocks();
      mockResolveToken.mockReturnValue(undefined as unknown as string);

      await expect(pull({ dataDir, configPath })).rejects.toThrow('No access token found');
    });
  });

  describe('symlink safety', () => {
    it('succeeds on same-minute re-run (symlink overwrite)', async () => {
      writeConfig();
      setupMocks();

      // First run
      const result1 = await pull({ dataDir, configPath });
      expect(result1.pipelineStatus.status).toBe('complete');

      // Second run in the same minute — same runDir name, symlinks already exist
      const result2 = await pull({ dataDir, configPath });
      expect(result2.pipelineStatus.status).toBe('complete');
    });
  });

  describe('campaigns-summary required', () => {
    it('throws when campaigns-summary.json not produced', async () => {
      writeConfig();
      setupMocks();

      // Mock summarize to be a no-op so campaigns-summary.json is never created
      const spy = vi.spyOn(summarizeModule, 'summarize').mockResolvedValue(undefined as never);

      try {
        await expect(pull({ dataDir, configPath })).rejects.toThrow('campaigns-summary.json');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('META_ADS_DATA_DIR env var', () => {
    it('reads META_ADS_DATA_DIR when options.dataDir not set', async () => {
      const envDataDir = path.join(tmpDir, 'env-data');
      process.env['META_ADS_DATA_DIR'] = envDataDir;
      writeConfig();
      setupMocks();

      try {
        const result = await pull({ configPath });
        expect(result.runDir).toContain(envDataDir);
      } finally {
        delete process.env['META_ADS_DATA_DIR'];
      }
    });
  });
});
