import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';

const BASE_URL = 'https://graph.facebook.com';
const TOKEN = 'test_access_token_123';

// Mock the auth module to return our test token
vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: () => TOKEN,
}));

// We test the HTTP layer directly since Commander actions call process.exit
describe('accounts API integration', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should list ad accounts', async () => {
    const mockResponse = {
      data: [
        {
          id: 'act_123456',
          name: 'Test Ad Account',
          account_id: '123456',
          account_status: 1,
          currency: 'USD',
          timezone_name: 'America/New_York',
          amount_spent: '5000',
        },
        {
          id: 'act_789012',
          name: 'Second Account',
          account_id: '789012',
          account_status: 2,
          currency: 'EUR',
          timezone_name: 'Europe/London',
          amount_spent: '3000',
        },
      ],
      paging: {
        cursors: {
          before: 'abc',
          after: 'def',
        },
      },
    };

    nock(BASE_URL)
      .get('/v21.0/me/adaccounts')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/me/adaccounts',
      TOKEN,
      { params: { fields: 'id,name,account_id,account_status,currency,timezone_name,amount_spent' } },
    );

    expect(result.data).toHaveLength(2);
    expect(result.data![0].id).toBe('act_123456');
    expect(result.data![0].name).toBe('Test Ad Account');
    expect(result.data![1].account_status).toBe(2);
  });

  it('should get a specific ad account', async () => {
    const mockAccount = {
      id: 'act_123456',
      name: 'Test Ad Account',
      account_id: '123456',
      account_status: 1,
      currency: 'USD',
      timezone_name: 'America/New_York',
      amount_spent: '5000',
    };

    nock(BASE_URL)
      .get('/v21.0/act_123456')
      .query(true)
      .reply(200, mockAccount);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockAccount>(
      '/act_123456',
      TOKEN,
      { params: { fields: 'id,name,account_id,account_status,currency,timezone_name,amount_spent' } },
    );

    expect(result.id).toBe('act_123456');
    expect(result.name).toBe('Test Ad Account');
  });
});
