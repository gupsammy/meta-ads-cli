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

describe('adsets API integration', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should list ad sets', async () => {
    const mockResponse = {
      data: [
        {
          id: '1001',
          name: 'US Adults 25-45',
          status: 'ACTIVE',
          effective_status: 'ACTIVE',
          campaign_id: '111',
          daily_budget: '2000',
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'LINK_CLICKS',
          created_time: '2024-01-15T10:00:00+0000',
          updated_time: '2024-01-16T12:00:00+0000',
        },
      ],
      paging: {
        cursors: { before: 'abc', after: 'def' },
      },
    };

    nock(BASE_URL)
      .get('/v21.0/act_123456/adsets')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/act_123456/adsets',
      TOKEN,
      { params: { fields: 'id,name,status,effective_status,campaign_id,daily_budget,billing_event,optimization_goal,created_time,updated_time' } },
    );

    expect(result.data).toHaveLength(1);
    expect(result.data![0].name).toBe('US Adults 25-45');
    expect(result.data![0].billing_event).toBe('IMPRESSIONS');
  });

  it('should create an ad set', async () => {
    nock(BASE_URL)
      .post('/v21.0/act_123456/adsets')
      .reply(200, { id: '1002' });

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<{ id: string }>(
      '/act_123456/adsets',
      TOKEN,
      {
        method: 'POST',
        body: {
          campaign_id: '111',
          name: 'New Ad Set',
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'LINK_CLICKS',
          daily_budget: '2000',
          status: 'PAUSED',
          targeting: { geo_locations: { countries: ['US'] } },
        },
      },
    );

    expect(result.id).toBe('1002');
  });

  it('should update an ad set', async () => {
    nock(BASE_URL)
      .post('/v21.0/1001')
      .reply(200, { success: true });

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<{ success: boolean }>(
      '/1001',
      TOKEN,
      {
        method: 'POST',
        body: { name: 'Updated Ad Set', status: 'PAUSED' },
      },
    );

    expect(result.success).toBe(true);
  });
});
