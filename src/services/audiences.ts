import { paginateAll, graphRequestWithRetry } from '../lib/http.js';
import type { PaginatedResult } from '../lib/http.js';
import { normalizeAccountId } from './accounts.js';
import type { AudienceListItem, AudienceDetail, ListAudiencesOptions } from './types.js';

interface RawCustomAudience {
  id: string;
  name: string;
  description?: string;
  subtype: string;
  approximate_count_lower_bound?: number;
  approximate_count_upper_bound?: number;
  time_created?: string;
  time_updated?: string;
  delivery_status?: { status: string };
}

const AUDIENCE_FIELDS = 'id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_created,time_updated,delivery_status';

function mapAudienceListItem(a: RawCustomAudience): AudienceListItem {
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? '',
    subtype: a.subtype,
    approx_count_lower: a.approximate_count_lower_bound ?? '',
    approx_count_upper: a.approximate_count_upper_bound ?? '',
    delivery_status: a.delivery_status?.status ?? '',
    time_created: a.time_created ?? '',
  };
}

export async function listAudiences(
  token: string,
  opts: ListAudiencesOptions,
): Promise<PaginatedResult<AudienceListItem>> {
  const accountId = normalizeAccountId(opts.accountId);
  const params: Record<string, string> = { fields: AUDIENCE_FIELDS };
  if (opts.after) params['after'] = opts.after;

  const limit = opts.limit ?? 50;

  const result = await paginateAll<RawCustomAudience>(
    `/${accountId}/customaudiences`,
    token,
    { params },
    limit,
  );

  return {
    data: result.data.map(mapAudienceListItem),
    has_more: result.has_more,
    next_cursor: result.next_cursor,
  };
}

export async function getAudience(
  token: string,
  audienceId: string,
): Promise<AudienceDetail> {
  const params: Record<string, string> = { fields: AUDIENCE_FIELDS };

  const a = await graphRequestWithRetry<RawCustomAudience>(`/${audienceId}`, token, { params });

  return {
    ...mapAudienceListItem(a),
    time_updated: a.time_updated ?? '',
  };
}
