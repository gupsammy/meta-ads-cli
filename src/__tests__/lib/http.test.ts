import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { graphRequest, HttpError } from '../../lib/http.js';

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
      .query({ access_token: TOKEN, fields: 'id,name' })
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
      .query({ access_token: TOKEN })
      .reply(200, { id: '456' });

    const result = await graphRequest<{ id: string }>('/act_123/campaigns', TOKEN, {
      method: 'POST',
      body: { name: 'Test Campaign', objective: 'OUTCOME_TRAFFIC' },
    });

    expect(result.id).toBe('456');
  });
});
