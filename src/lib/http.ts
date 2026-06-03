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

/** POST /{node}/insights response — the handle to a queued async report job. */
export interface AsyncReportSubmit {
  report_run_id?: string;
  id?: string;
}

/** GET /{report_run_id} response — the report job's progress node. */
export interface AsyncReportStatus {
  id?: string;
  async_status?: string;
  async_percent_completion?: number;
}

/**
 * Fetch insights via Meta's ASYNC report API instead of the synchronous edge.
 *
 * The synchronous GET /{node}/insights rejects heavy queries — notably
 * ad-level × daily (time_increment=1) over a whole account — with error code 1,
 * "Please reduce the amount of data you're asking for". A row LIMIT does not
 * help: Meta computes the full result set before paginating, then refuses. Its
 * documented remedy is the async report flow, which runs server-side without a
 * response-size ceiling:
 *   1. POST /{node}/insights {params}        → { report_run_id }
 *   2. poll GET /{report_run_id}             → async_status until 'Job Completed'
 *   3. GET  /{report_run_id}/insights (paged) → the rows
 *
 * Signature mirrors paginateAll's (path, token, options, limit) so call sites
 * and tests read the same as the sync path. `pollOptions.intervalMs` is exposed
 * so tests can poll with zero delay. Terminal failure states ('Job Failed' /
 * 'Job Skipped') and a deadline (bounded under the supervisor's SIGKILL) both
 * throw rather than spin forever.
 */
export async function fetchInsightsAsync<T>(
  path: string,
  accessToken: string,
  options: HttpOptions = {},
  limit?: number,
  pollOptions: { intervalMs?: number; maxWaitMs?: number } = {},
): Promise<PaginatedResult<T>> {
  const intervalMs = pollOptions.intervalMs ?? 2_000;
  const maxWaitMs = pollOptions.maxWaitMs ?? 8 * 60 * 1000;

  // 1. Submit the report job. The query params (level/fields/time_increment/
  //    date_preset/filtering) ride as the POST body — graphRequest form-encodes
  //    them — so the async request is shape-for-shape identical to the sync one.
  const submit = await graphRequest<AsyncReportSubmit>(path, accessToken, {
    method: 'POST',
    body: { ...(options.params ?? {}) },
  });
  const reportRunId = submit.report_run_id ?? submit.id;
  if (!reportRunId) {
    throw new HttpError('Async insights: no report_run_id returned', 'ASYNC_NO_ID', 502);
  }

  // 2. Poll to completion. Not-Started/Started/Running keep waiting; Failed/
  //    Skipped are terminal; the deadline caps a wedged job.
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const status = await graphRequestWithRetry<AsyncReportStatus>(`/${reportRunId}`, accessToken);
    const state = status.async_status;
    if (state === 'Job Completed') break;
    if (state === 'Job Failed' || state === 'Job Skipped') {
      throw new HttpError(`Async insights report ${state}`, 'ASYNC_REPORT_FAILED', 502);
    }
    if (Date.now() >= deadline) {
      throw new HttpError('Async insights report did not complete in time', 'ASYNC_TIMEOUT', 504);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // 3. Read the completed report's rows. The report edge paginates like any
  //    other, so reuse paginateAll for cursor handling + identical limit semantics.
  return paginateAll<T>(`/${reportRunId}/insights`, accessToken, {}, limit);
}
