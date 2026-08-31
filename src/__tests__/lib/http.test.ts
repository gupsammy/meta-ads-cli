import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { graphRequest, paginateAll, fetchInsightsAsync, HttpError } from '../../lib/http.js';

const BASE_URL = 'https://graph.facebook.com';
const TOKEN = 'test_access_token_123';

describe('graphRequest', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should make a GET request with access token', async () => {
    const mockData = {
      data: [{ id: '123', name: 'Test Account' }],
    };

    nock(BASE_URL)
      .get('/v21.0/me/adaccounts')
      .query({ fields: 'id,name' })
      .reply(200, mockData);

    const result = await graphRequest('/me/adaccounts', TOKEN, {
      params: { fields: 'id,name' },
    });

    expect(result).toEqual(mockData);
  });

  it('should throw HttpError on 401', async () => {
    nock(BASE_URL)
      .get('/v21.0/me/adaccounts')
      .query(true)
      .reply(401, {
        error: {
          message: 'Invalid OAuth access token',
          type: 'OAuthException',
          code: 190,
        },
      });

    try {
      await graphRequest('/me/adaccounts', TOKEN, { params: {} });
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe('AUTH_FAILED');
    }
  });

  it('should throw HttpError on 429 rate limit', async () => {
    nock(BASE_URL)
      .get('/v21.0/me/adaccounts')
      .query(true)
      .reply(429, {
        error: {
          message: 'Too many calls',
          type: 'OAuthException',
          code: 32,
        },
      }, {
        'retry-after': '30',
      });

    try {
      await graphRequest('/me/adaccounts', TOKEN, { params: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe('RATE_LIMITED');
      expect((error as HttpError).retryAfter).toBe(30);
    }
  });

  it('should throw HttpError on API error', async () => {
    nock(BASE_URL)
      .get('/v21.0/act_123/campaigns')
      .query(true)
      .reply(400, {
        error: {
          message: '(#100) Invalid parameter',
          type: 'OAuthException',
          code: 100,
        },
      });

    try {
      await graphRequest('/act_123/campaigns', TOKEN, { params: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).message).toContain('Invalid parameter');
    }
  });

  it('should make POST request with form body', async () => {
    nock(BASE_URL)
      .post('/v21.0/act_123/campaigns')
      .reply(200, { id: '456' });

    const result = await graphRequest<{ id: string }>('/act_123/campaigns', TOKEN, {
      method: 'POST',
      body: { name: 'Test Campaign', objective: 'OUTCOME_TRAFFIC' },
    });

    expect(result.id).toBe('456');
  });
});

describe('paginateAll', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should return PaginatedResult with has_more false when no next page', async () => {
    nock(BASE_URL)
      .get('/v21.0/act_123/campaigns')
      .query(true)
      .reply(200, {
        data: [{ id: '1' }, { id: '2' }],
        paging: {
          cursors: { before: 'a', after: 'b' },
        },
      });

    const result = await paginateAll<{ id: string }>('/act_123/campaigns', TOKEN, {
      params: { fields: 'id' },
    });

    expect(result.data).toHaveLength(2);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeUndefined();
  });

  it('should set has_more true and return cursor when limited', async () => {
    nock(BASE_URL)
      .get('/v21.0/act_123/campaigns')
      .query(true)
      .reply(200, {
        data: [{ id: '1' }, { id: '2' }, { id: '3' }],
        paging: {
          cursors: { before: 'a', after: 'cursor_xyz' },
          next: 'https://graph.facebook.com/v21.0/act_123/campaigns?after=cursor_xyz',
        },
      });

    const result = await paginateAll<{ id: string }>('/act_123/campaigns', TOKEN, {
      params: { fields: 'id' },
    }, 2);

    expect(result.data).toHaveLength(2);
    expect(result.has_more).toBe(true);
    // cursor_xyz points after item 3, not item 2 — returning it would skip item 3.
    // When the page was truncated mid-page, no valid cursor exists.
    expect(result.next_cursor).toBeUndefined();
  });

  it('should forward after cursor from options.params to API request', async () => {
    nock(BASE_URL)
      .get('/v21.0/act_123/campaigns')
      .query({ fields: 'id', after: 'cursor_page2', limit: '10' })
      .reply(200, {
        data: [{ id: '3' }, { id: '4' }],
        paging: { cursors: { before: 'b', after: 'cursor_page3' } },
      });

    const result = await paginateAll<{ id: string }>('/act_123/campaigns', TOKEN, {
      params: { fields: 'id', after: 'cursor_page2' },
    }, 10);

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('3');
    expect(result.has_more).toBe(false);
  });

  it('should paginate through multiple pages', async () => {
    nock(BASE_URL)
      .get('/v21.0/act_123/campaigns')
      .query(true)
      .reply(200, {
        data: [{ id: '1' }],
        paging: {
          cursors: { before: 'a', after: 'b' },
          next: 'https://graph.facebook.com/v21.0/act_123/campaigns?after=b',
        },
      });

    nock(BASE_URL)
      .get('/v21.0/act_123/campaigns')
      .query(true)
      .reply(200, {
        data: [{ id: '2' }],
        paging: {
          cursors: { before: 'b', after: 'c' },
        },
      });

    const result = await paginateAll<{ id: string }>('/act_123/campaigns', TOKEN, {
      params: { fields: 'id' },
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('1');
    expect(result.data[1].id).toBe('2');
    expect(result.has_more).toBe(false);
  });
});

describe('fetchInsightsAsync', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('submits a report job, polls to completion, and returns the rows', async () => {
    nock(BASE_URL).post('/v21.0/act_123/insights').reply(200, { report_run_id: '999' });
    nock(BASE_URL).get('/v21.0/999').query(true).reply(200, { id: '999', async_status: 'Job Completed' });
    nock(BASE_URL).get('/v21.0/999/insights').query(true).reply(200, {
      data: [{ ad_id: 'a1', spend: '10' }, { ad_id: 'a2', spend: '20' }],
      paging: { cursors: { after: 'x' } },
    });

    const result = await fetchInsightsAsync<{ ad_id: string }>(
      '/act_123/insights',
      TOKEN,
      { params: { level: 'ad', time_increment: '1' } },
      undefined,
      { intervalMs: 0 },
    );

    expect(result.data).toHaveLength(2);
    expect(result.data[0].ad_id).toBe('a1');
    expect(result.has_more).toBe(false);
  });

  it('retries the submit on a transient 5xx before succeeding', async () => {
    // Regression: the submit POST must go through graphRequestWithRetry like the
    // poll/page steps. With bare graphRequest the first 503 would throw and the
    // whole intel run would die on a transient error.
    nock(BASE_URL).post('/v21.0/act_123/insights').reply(503, { error: { message: 'temporarily unavailable', code: 2 } });
    nock(BASE_URL).post('/v21.0/act_123/insights').reply(200, { report_run_id: '888' });
    nock(BASE_URL).get('/v21.0/888').query(true).reply(200, { id: '888', async_status: 'Job Completed' });
    nock(BASE_URL).get('/v21.0/888/insights').query(true).reply(200, { data: [{ ad_id: 'a1' }] });

    const result = await fetchInsightsAsync<{ ad_id: string }>(
      '/act_123/insights',
      TOKEN,
      { params: { level: 'ad' } },
      undefined,
      { intervalMs: 0 },
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].ad_id).toBe('a1');
  });

  it('polls repeatedly until the job leaves a running state', async () => {
    nock(BASE_URL).post('/v21.0/act_123/insights').reply(200, { report_run_id: '777' });
    nock(BASE_URL).get('/v21.0/777').query(true).reply(200, { id: '777', async_status: 'Job Running', async_percent_completion: 40 });
    nock(BASE_URL).get('/v21.0/777').query(true).reply(200, { id: '777', async_status: 'Job Completed', async_percent_completion: 100 });
    nock(BASE_URL).get('/v21.0/777/insights').query(true).reply(200, { data: [{ ad_id: 'a1' }] });

    const result = await fetchInsightsAsync<{ ad_id: string }>(
      '/act_123/insights',
      TOKEN,
      { params: { level: 'ad' } },
      undefined,
      { intervalMs: 0 },
    );

    expect(result.data).toHaveLength(1);
  });

  it('throws when the report job fails', async () => {
    nock(BASE_URL).post('/v21.0/act_123/insights').reply(200, { report_run_id: '500' });
    nock(BASE_URL).get('/v21.0/500').query(true).reply(200, { id: '500', async_status: 'Job Failed' });

    await expect(
      fetchInsightsAsync('/act_123/insights', TOKEN, { params: { level: 'ad' } }, undefined, { intervalMs: 0 }),
    ).rejects.toThrow(/Job Failed/);
  });

  it('throws when no report_run_id is returned', async () => {
    nock(BASE_URL).post('/v21.0/act_123/insights').reply(200, {});

    await expect(
      fetchInsightsAsync('/act_123/insights', TOKEN, { params: {} }, undefined, { intervalMs: 0 }),
    ).rejects.toThrow(/report_run_id/);
  });
});
