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

describe('audiences API integration', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should list custom audiences', async () => {
    const mockResponse = {
      data: [
        {
          id: '7001',
          name: 'Website Visitors',
          description: 'People who visited the website in the last 30 days',
          subtype: 'WEBSITE',
          approximate_count_lower_bound: 5000,
          approximate_count_upper_bound: 6000,
          time_created: '2024-01-10T10:00:00+0000',
          time_updated: '2024-01-20T10:00:00+0000',
          delivery_status: { status: 'ready' },
        },
        {
          id: '7002',
          name: 'Customer List',
          description: 'Uploaded customer email list',
          subtype: 'CUSTOM',
          approximate_count_lower_bound: 10000,
          approximate_count_upper_bound: 12000,
          time_created: '2024-02-01T08:00:00+0000',
          time_updated: '2024-02-05T12:00:00+0000',
          delivery_status: { status: 'ready' },
        },
      ],
      paging: {
        cursors: { before: 'abc', after: 'def' },
      },
    };

    nock(BASE_URL)
      .get('/v21.0/act_123456/customaudiences')
      .query(true)
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/act_123456/customaudiences',
      TOKEN,
      { params: { fields: 'id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_created,time_updated,delivery_status' } },
    );

    expect(result.data).toHaveLength(2);
    expect(result.data![0].name).toBe('Website Visitors');
    expect(result.data![0].subtype).toBe('WEBSITE');
    expect(result.data![1].approximate_count_lower_bound).toBe(10000);
  });

  it('should get a specific custom audience', async () => {
    const mockAudience = {
      id: '7001',
      name: 'Website Visitors',
      description: 'People who visited the website in the last 30 days',
      subtype: 'WEBSITE',
      approximate_count_lower_bound: 5000,
      approximate_count_upper_bound: 6000,
      time_created: '2024-01-10T10:00:00+0000',
      time_updated: '2024-01-20T10:00:00+0000',
      delivery_status: { status: 'ready' },
    };

    nock(BASE_URL)
      .get('/v21.0/7001')
      .query(true)
      .reply(200, mockAudience);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockAudience>(
      '/7001',
      TOKEN,
      { params: { fields: 'id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_created,time_updated,delivery_status' } },
    );

    expect(result.id).toBe('7001');
    expect(result.name).toBe('Website Visitors');
    expect(result.subtype).toBe('WEBSITE');
  });
});
