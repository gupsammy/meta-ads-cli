import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';

const BASE_URL = 'https://graph.facebook.com';
const TOKEN = 'test_access_token_123';

const mockConfig = {
  read: vi.fn().mockReturnValue({}),
  write: vi.fn(),
  getDefault: vi.fn().mockReturnValue(undefined),
  setDefault: vi.fn(),
  getConfigPath: vi.fn().mockReturnValue('/mock/config.json'),
  getConfigDir: vi.fn().mockReturnValue('/mock'),
};

vi.mock('../../lib/config.js', () => ({
  ConfigManager: vi.fn().mockImplementation(() => mockConfig),
}));

vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: (v?: string) => v ?? TOKEN,
  saveToken: vi.fn(),
  exchangeForLongLivedToken: vi.fn(),
  requireAccountId: (v?: string) => v?.startsWith('act_') ? v : `act_${v}`,
  resolveAccountId: (v?: string) => v ? (v.startsWith('act_') ? v : `act_${v}`) : undefined,
}));

describe('setup command', () => {
  beforeEach(() => {
    nock.cleanAll();
    mockConfig.getDefault.mockReturnValue(undefined);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should verify token via debug_token endpoint', async () => {
    const mockDebugResponse = {
      data: {
        app_id: '123',
        type: 'USER',
        is_valid: true,
        expires_at: Math.floor(Date.now() / 1000) + 86400 * 60,
        scopes: ['ads_management', 'ads_read'],
      },
    };

    nock(BASE_URL)
      .get('/v21.0/debug_token')
      .query(true)
      .reply(200, mockDebugResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockDebugResponse>(
      '/debug_token',
      TOKEN,
      { params: { input_token: TOKEN } },
    );

    expect(result.data.is_valid).toBe(true);
    expect(result.data.expires_at).toBeGreaterThan(0);
  });

  it('should list ad accounts for selection', async () => {
    const mockResponse = {
      data: [
        { id: 'act_111', name: 'Account A', account_id: '111', account_status: 1, currency: 'USD' },
        { id: 'act_222', name: 'Account B', account_id: '222', account_status: 1, currency: 'EUR' },
      ],
      paging: { cursors: { before: 'a', after: 'b' } },
    };

    nock(BASE_URL)
      .get('/v21.0/me/adaccounts')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/me/adaccounts',
      TOKEN,
      { params: { fields: 'id,name,account_id,account_status,currency' } },
    );

    expect(result.data).toHaveLength(2);
    expect(result.data![0].id).toBe('act_111');
    expect(result.data![1].currency).toBe('EUR');
  });

  it('should run health check against account endpoint', async () => {
    const mockAccount = {
      id: 'act_111',
      name: 'Test Account',
      currency: 'USD',
      account_status: 1,
    };

    nock(BASE_URL)
      .get('/v21.0/act_111')
      .query(true)
      .reply(200, mockAccount);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockAccount>(
      '/act_111',
      TOKEN,
      { params: { fields: 'id,name,currency,account_status' } },
    );

    expect(result.name).toBe('Test Account');
    expect(result.account_status).toBe(1);
  });
});
