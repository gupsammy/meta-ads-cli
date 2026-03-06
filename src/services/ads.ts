import { paginateAll, graphRequestWithRetry } from '../lib/http.js';
import type { PaginatedResult } from '../lib/http.js';
import { normalizeAccountId } from './accounts.js';
import type {
  AdListItem,
  AdDetail,
  ListAdsOptions,
  UpdateAdOptions,
  UpdateResult,
  DryRunResult,
} from './types.js';

interface RawAd {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  adset_id: string;
  campaign_id: string;
  creative?: { id: string; title?: string; body?: string; image_url?: string; thumbnail_url?: string };
  created_time: string;
  updated_time: string;
}

const AD_FIELDS = 'id,name,status,effective_status,adset_id,campaign_id,creative{id,title,body,image_url,thumbnail_url},created_time,updated_time';

function mapAd(a: RawAd): AdListItem {
  return {
    id: a.id,
    name: a.name,
    adset_id: a.adset_id,
    campaign_id: a.campaign_id,
    status: a.status,
    effective_status: a.effective_status,
    creative_id: a.creative?.id ?? '',
    creative_title: a.creative?.title ?? '',
    creative_body: a.creative?.body ?? '',
    creative_image_url: a.creative?.image_url ?? '',
    creative_thumbnail_url: a.creative?.thumbnail_url ?? '',
    created_time: a.created_time,
  };
}

function mapAdDetail(a: RawAd): AdDetail {
  return {
    ...mapAd(a),
    updated_time: a.updated_time,
  };
}

export async function listAds(
  token: string,
  opts: ListAdsOptions,
): Promise<PaginatedResult<AdListItem>> {
  const accountId = normalizeAccountId(opts.accountId);
  const params: Record<string, string> = { fields: AD_FIELDS };
  if (opts.after) params['after'] = opts.after;

  const filtering: Array<{ field: string; operator: string; value: string[] }> = [];
  if (opts.status) {
    filtering.push({ field: 'effective_status', operator: 'IN', value: [opts.status] });
  }
  if (opts.adsetId) {
    filtering.push({ field: 'adset_id', operator: 'EQUAL', value: [opts.adsetId] });
  }
  if (opts.campaignId) {
    filtering.push({ field: 'campaign_id', operator: 'EQUAL', value: [opts.campaignId] });
  }
  if (filtering.length > 0) {
    params['filtering'] = JSON.stringify(filtering);
  }

  const limit = opts.limit ?? 50;

  const result = await paginateAll<RawAd>(
    `/${accountId}/ads`,
    token,
    { params },
    limit,
  );

  return {
    data: result.data.map(mapAd),
    has_more: result.has_more,
    next_cursor: result.next_cursor,
  };
}

export async function getAd(
  token: string,
  adId: string,
): Promise<AdDetail> {
  const params: Record<string, string> = { fields: AD_FIELDS };
  const ad = await graphRequestWithRetry<RawAd>(`/${adId}`, token, { params });
  return mapAdDetail(ad);
}

export function buildUpdateAdBody(opts: UpdateAdOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name) body['name'] = opts.name;
  if (opts.status) body['status'] = opts.status;
  return body;
}

export function dryRunUpdateAd(opts: UpdateAdOptions): DryRunResult {
  return {
    dry_run: true,
    method: 'POST',
    path: `/${opts.adId}`,
    body: buildUpdateAdBody(opts),
  };
}

export async function updateAd(
  token: string,
  opts: UpdateAdOptions,
): Promise<UpdateResult> {
  const body = buildUpdateAdBody(opts);

  const result = await graphRequestWithRetry<{ success: boolean }>(
    `/${opts.adId}`,
    token,
    { method: 'POST', body },
  );

  return {
    id: opts.adId,
    updated: result.success ?? true,
    changes: body,
  };
}
