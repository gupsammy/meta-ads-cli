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

describe('campaigns API integration', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should list campaigns', async () => {
    const mockResponse = {
      data: [
        {
          id: '111',
          name: 'Summer Sale',
          status: 'ACTIVE',
          effective_status: 'ACTIVE',
          objective: 'OUTCOME_SALES',
          daily_budget: '5000',
          created_time: '2024-01-15T10:00:00+0000',
          updated_time: '2024-01-16T12:00:00+0000',
        },
        {
          id: '222',
          name: 'Brand Awareness',
          status: 'PAUSED',
          effective_status: 'PAUSED',
          objective: 'OUTCOME_AWARENESS',
          daily_budget: '3000',
          created_time: '2024-02-01T08:00:00+0000',
          updated_time: '2024-02-02T09:00:00+0000',
        },
      ],
      paging: {
        cursors: { before: 'abc', after: 'def' },
        next: 'https://graph.facebook.com/v21.0/act_123/campaigns?after=def',
      },
    };

    nock(BASE_URL)
      .get('/v21.0/act_123456/campaigns')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/act_123456/campaigns',
      TOKEN,
      { params: { fields: 'id,name,status,effective_status,objective,daily_budget,created_time,updated_time' } },
    );

    expect(result.data).toHaveLength(2);
    expect(result.data![0].name).toBe('Summer Sale');
    expect(result.data![0].objective).toBe('OUTCOME_SALES');
    expect(result.data![1].status).toBe('PAUSED');
  });

  it('should get a specific campaign', async () => {
    const mockCampaign = {
      id: '111',
      name: 'Summer Sale',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      objective: 'OUTCOME_SALES',
      daily_budget: '5000',
      created_time: '2024-01-15T10:00:00+0000',
      updated_time: '2024-01-16T12:00:00+0000',
      start_time: '2024-01-15T10:00:00+0000',
      stop_time: '2024-06-30T23:59:59+0000',
    };

    nock(BASE_URL)
      .get('/v21.0/111')
      .query(true)
      .reply(200, mockCampaign);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockCampaign>(
      '/111',
      TOKEN,
      { params: { fields: 'id,name,status,effective_status,objective,daily_budget,created_time,updated_time,start_time,stop_time' } },
    );

    expect(result.id).toBe('111');
    expect(result.name).toBe('Summer Sale');
  });

  it('should create a campaign', async () => {
    nock(BASE_URL)
      .post('/v21.0/act_123456/campaigns')
      .reply(200, { id: '333' });

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<{ id: string }>(
      '/act_123456/campaigns',
      TOKEN,
      {
        method: 'POST',
        body: {
          name: 'New Campaign',
          objective: 'OUTCOME_TRAFFIC',
          status: 'PAUSED',
          special_ad_categories: [],
        },
      },
    );

    expect(result.id).toBe('333');
  });

  it('should update a campaign', async () => {
    nock(BASE_URL)
      .post('/v21.0/111')
      .reply(200, { success: true });

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<{ success: boolean }>(
      '/111',
      TOKEN,
      {
        method: 'POST',
        body: { name: 'Updated Campaign', status: 'ACTIVE' },
      },
    );

    expect(result.success).toBe(true);
  });
});
