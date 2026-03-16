import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';

const BASE_URL = 'https://graph.facebook.com';
const TOKEN = 'test_access_token_123';

vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: () => TOKEN,
  requireAccountId: (v?: string) => v?.startsWith('act_') ? v : `act_${v}`,
  resolveAccountId: (v?: string) => v ? (v.startsWith('act_') ? v : `act_${v}`) : undefined,
}));

describe('ads API integration', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should list ads', async () => {
    const mockResponse = {
      data: [
        {
          id: '5001',
          name: 'Summer Banner Ad',
          status: 'ACTIVE',
          effective_status: 'ACTIVE',
          adset_id: '1001',
          campaign_id: '111',
          creative: { id: '9001' },
          created_time: '2024-01-15T10:00:00+0000',
          updated_time: '2024-01-16T12:00:00+0000',
        },
        {
          id: '5002',
          name: 'Summer Video Ad',
          status: 'PAUSED',
          effective_status: 'PAUSED',
          adset_id: '1001',
          campaign_id: '111',
          creative: { id: '9002' },
          created_time: '2024-01-17T08:00:00+0000',
          updated_time: '2024-01-18T09:00:00+0000',
        },
      ],
      paging: {
        cursors: { before: 'abc', after: 'def' },
      },
    };

    nock(BASE_URL)
      .get('/v21.0/act_123456/ads')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/act_123456/ads',
      TOKEN,
      { params: { fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id},created_time,updated_time' } },
    );

    expect(result.data).toHaveLength(2);
    expect(result.data![0].name).toBe('Summer Banner Ad');
    expect(result.data![0].creative?.id).toBe('9001');
  });

  it('should get a specific ad', async () => {
    const mockAd = {
      id: '5001',
      name: 'Summer Banner Ad',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      adset_id: '1001',
      campaign_id: '111',
      creative: { id: '9001' },
      created_time: '2024-01-15T10:00:00+0000',
      updated_time: '2024-01-16T12:00:00+0000',
    };

    nock(BASE_URL)
      .get('/v21.0/5001')
      .query(true)
      .reply(200, mockAd);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockAd>(
      '/5001',
      TOKEN,
      { params: { fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id},created_time,updated_time' } },
    );

    expect(result.id).toBe('5001');
    expect(result.name).toBe('Summer Banner Ad');
  });

  it('should update an ad', async () => {
    nock(BASE_URL)
      .post('/v21.0/5001')
      .reply(200, { success: true });

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<{ success: boolean }>(
      '/5001',
      TOKEN,
      {
        method: 'POST',
        body: { status: 'PAUSED' },
      },
    );

    expect(result.success).toBe(true);
  });
});
