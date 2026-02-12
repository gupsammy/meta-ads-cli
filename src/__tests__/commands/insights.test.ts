import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';

const BASE_URL = 'https://graph.facebook.com';
const TOKEN = 'test_access_token_123';

vi.mock('../../auth.js', () => ({
  requireAccessToken: () => TOKEN,
  resolveAccessToken: () => TOKEN,
}));

describe('insights API integration', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should get account-level insights', async () => {
    const mockResponse = {
      data: [
        {
          account_id: '123456',
          impressions: '50000',
          clicks: '1500',
          spend: '250.50',
          cpc: '0.167',
          cpm: '5.01',
          ctr: '3.0',
          reach: '40000',
          frequency: '1.25',
          date_start: '2024-01-01',
          date_stop: '2024-01-31',
        },
      ],
      paging: {
        cursors: { before: 'abc', after: 'def' },
      },
    };

    nock(BASE_URL)
      .get('/v21.0/act_123456/insights')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/act_123456/insights',
      TOKEN,
      { params: { fields: 'account_id,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,date_start,date_stop', date_preset: 'last_30d' } },
    );

    expect(result.data).toHaveLength(1);
    expect(result.data![0].impressions).toBe('50000');
    expect(result.data![0].spend).toBe('250.50');
    expect(result.data![0].ctr).toBe('3.0');
  });

  it('should get campaign-level insights', async () => {
    const mockResponse = {
      data: [
        {
          campaign_id: '111',
          campaign_name: 'Summer Sale',
          impressions: '20000',
          clicks: '800',
          spend: '120.00',
          cpc: '0.15',
          cpm: '6.00',
          ctr: '4.0',
          reach: '15000',
          frequency: '1.33',
          date_start: '2024-01-01',
          date_stop: '2024-01-31',
        },
      ],
    };

    nock(BASE_URL)
      .get('/v21.0/111/insights')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/111/insights',
      TOKEN,
      { params: { fields: 'campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,date_start,date_stop' } },
    );

    expect(result.data).toHaveLength(1);
    expect(result.data![0].campaign_name).toBe('Summer Sale');
  });

  it('should get insights with time range', async () => {
    const mockResponse = {
      data: [
        {
          account_id: '123456',
          impressions: '10000',
          clicks: '300',
          spend: '50.00',
          date_start: '2024-03-01',
          date_stop: '2024-03-15',
        },
      ],
    };

    nock(BASE_URL)
      .get('/v21.0/act_123456/insights')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/act_123456/insights',
      TOKEN,
      {
        params: {
          fields: 'account_id,impressions,clicks,spend,date_start,date_stop',
          time_range: JSON.stringify({ since: '2024-03-01', until: '2024-03-15' }),
        },
      },
    );

    expect(result.data).toHaveLength(1);
    expect(result.data![0].date_start).toBe('2024-03-01');
  });
});
