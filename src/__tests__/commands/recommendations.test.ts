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

describe('recommendations API integration', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should fetch account recommendations via POST', async () => {
    const mockResponse = {
      opportunity_score: 82,
      data: [
        {
          type: 'BUDGET_INCREASE',
          description: 'Increase budget for top performing ad set',
          estimated_impact_score: 0.9,
          api_apply_supported: true,
        },
        {
          type: 'AUDIENCE_EXPANSION',
          description: 'Expand your audience to reach more potential customers',
          estimated_impact_score: 0.7,
          api_apply_supported: false,
        },
      ],
    };

    nock(BASE_URL)
      .post('/v21.0/act_123456/recommendations')
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/act_123456/recommendations',
      TOKEN,
      { method: 'POST' },
    );

    expect(result.opportunity_score).toBe(82);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].type).toBe('BUDGET_INCREASE');
    expect(result.data[1].type).toBe('AUDIENCE_EXPANSION');
  });

  it('should return empty data array when no recommendations available', async () => {
    const mockResponse = {
      opportunity_score: 0,
      data: [],
    };

    nock(BASE_URL)
      .post('/v21.0/act_999/recommendations')
      .reply(200, mockResponse);

    const { graphRequestWithRetry } = await import('../../lib/http.js');
    const result = await graphRequestWithRetry<typeof mockResponse>(
      '/act_999/recommendations',
      TOKEN,
      { method: 'POST' },
    );

    expect(result.opportunity_score).toBe(0);
    expect(result.data).toHaveLength(0);
  });
});
