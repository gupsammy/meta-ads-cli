import { API_VERSION } from './constants.js';

const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  timeout?: number;
}

export interface GraphApiResponse<T> {
  data?: T[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
    previous?: string;
  };
}

export interface GraphApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export class HttpError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function buildUrl(path: string, params?: Record<string, string>): string {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  if (!params || Object.keys(params).length === 0) return url;
  const searchParams = new URLSearchParams(params);
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${searchParams.toString()}`;
}

export async function graphRequest<T>(
  path: string,
  accessToken: string,
  options: HttpOptions = {},
): Promise<T> {
  const { method = 'GET', headers = {}, body, params = {}, timeout = 30_000 } = options;

  const url = buildUrl(path, method === 'GET' ? params : undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...headers,
      },
      signal: controller.signal,
    };

    if (body && method !== 'GET') {
      const formParams = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...body, ...params })) {
        formParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      init.body = formParams.toString();
      init.headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${accessToken}`,
        ...headers,
      };
    }

    const response = await fetch(url, init);

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new HttpError(
        'Rate limit exceeded',
        'RATE_LIMITED',
        429,
        retryAfter ? parseInt(retryAfter) : 60,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new HttpError(
        'Authentication failed. Check your access token or run: meta-ads auth login',
        'AUTH_FAILED',
        response.status,
      );
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(text || `HTTP ${response.status}`, 'API_ERROR', response.status);
    }

    if (!response.ok) {
      const graphError = json as GraphApiError;
      const message = graphError?.error?.message ?? `HTTP ${response.status}`;
      const code = graphError?.error?.code;
      throw new HttpError(message, `API_ERROR_${code ?? response.status}`, response.status);
    }

    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function graphRequestWithRetry<T>(
  path: string,
  accessToken: string,
  options: HttpOptions = {},
  maxRetries = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await graphRequest<T>(path, accessToken, options);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;
      if (error instanceof HttpError && (error.status === 429 || error.status >= 500)) {
        const delay = error.retryAfter ? error.retryAfter * 1000 : 1000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

export interface PaginatedResult<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string;
}

export async function paginateAll<T>(
  path: string,
  accessToken: string,
  options: HttpOptions = {},
  limit?: number,
): Promise<PaginatedResult<T>> {
  const allData: T[] = [];
  let nextUrl: string | undefined = undefined;
  let currentPath = path;

  // Inject limit into API params so server-side cursors align with page boundaries.
  const initialParams = { ...(options.params ?? {}) };
  if (limit && !initialParams['limit']) {
    initialParams['limit'] = String(limit);
  }
  let currentOptions: HttpOptions = { ...options, params: initialParams };

  while (true) {
    let response: GraphApiResponse<T>;
    if (nextUrl) {
      response = await graphRequestWithRetry<GraphApiResponse<T>>(nextUrl, accessToken);
    } else {
      response = await graphRequestWithRetry<GraphApiResponse<T>>(currentPath, accessToken, currentOptions);
    }

    if (response.data) {
      allData.push(...response.data);
    }

    if (limit && allData.length >= limit) {
      return {
        data: allData.slice(0, limit),
        has_more: !!response.paging?.next || allData.length > limit,
        next_cursor: allData.length === limit ? response.paging?.cursors?.after : undefined,
      };
    }

    if (response.paging?.next) {
      nextUrl = response.paging.next;
    } else {
      break;
    }
  }

  return {
    data: allData,
    has_more: false,
    next_cursor: undefined,
  };
}
