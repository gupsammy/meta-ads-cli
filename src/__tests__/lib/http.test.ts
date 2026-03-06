import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { graphRequest, paginateAll, HttpError } from '../../lib/http.js';

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
    expect(result.next_cursor).toBe('cursor_xyz');
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
