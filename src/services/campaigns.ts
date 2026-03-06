import { paginateAll, graphRequestWithRetry } from '../lib/http.js';
import type { PaginatedResult } from '../lib/http.js';
import { normalizeAccountId } from './accounts.js';
import type {
  CampaignListItem,
  CampaignDetail,
  ListCampaignsOptions,
  CreateCampaignOptions,
  CreateCampaignResult,
  UpdateCampaignOptions,
  UpdateResult,
  DryRunResult,
} from './types.js';

interface RawCampaign {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  objective: string;
  daily_budget?: string;
  lifetime_budget?: string;
  created_time: string;
  updated_time: string;
  start_time?: string;
  stop_time?: string;
}

const CAMPAIGN_FIELDS = 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time,start_time,stop_time';

export async function listCampaigns(
  token: string,
  opts: ListCampaignsOptions,
): Promise<PaginatedResult<CampaignListItem>> {
  const accountId = normalizeAccountId(opts.accountId);
  const params: Record<string, string> = { fields: CAMPAIGN_FIELDS };
  if (opts.after) params['after'] = opts.after;
  if (opts.status) {
    params['filtering'] = JSON.stringify([
      { field: 'effective_status', operator: 'IN', value: [opts.status] },
    ]);
  }

  const limit = opts.limit ?? 50;

  const result = await paginateAll<RawCampaign>(
    `/${accountId}/campaigns`,
    token,
    { params },
    limit,
  );

  return {
    data: result.data.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      effective_status: c.effective_status,
      objective: c.objective,
      daily_budget: c.daily_budget ?? '',
      lifetime_budget: c.lifetime_budget ?? '',
      created_time: c.created_time,
    })),
    has_more: result.has_more,
    next_cursor: result.next_cursor,
  };
}

export async function getCampaign(
  token: string,
  campaignId: string,
): Promise<CampaignDetail> {
  const params: Record<string, string> = { fields: CAMPAIGN_FIELDS };

  const c = await graphRequestWithRetry<RawCampaign>(`/${campaignId}`, token, { params });

  return {
    id: c.id,
    name: c.name,
    status: c.status,
    effective_status: c.effective_status,
    objective: c.objective,
    daily_budget: c.daily_budget ?? '',
    lifetime_budget: c.lifetime_budget ?? '',
    created_time: c.created_time,
    updated_time: c.updated_time,
    start_time: c.start_time ?? '',
    stop_time: c.stop_time ?? '',
  };
}

export function buildCreateCampaignBody(opts: CreateCampaignOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: opts.name,
    objective: opts.objective,
    status: opts.status ?? 'PAUSED',
    special_ad_categories: opts.specialAdCategories
      ? opts.specialAdCategories.split(',').map((s) => s.trim())
      : [],
  };
  if (opts.dailyBudget) body['daily_budget'] = opts.dailyBudget;
  if (opts.lifetimeBudget) body['lifetime_budget'] = opts.lifetimeBudget;
  return body;
}

export function dryRunCreateCampaign(opts: CreateCampaignOptions): DryRunResult {
  const accountId = normalizeAccountId(opts.accountId);
  return {
    dry_run: true,
    method: 'POST',
    path: `/${accountId}/campaigns`,
    body: buildCreateCampaignBody(opts),
  };
}

export async function createCampaign(
  token: string,
  opts: CreateCampaignOptions,
): Promise<CreateCampaignResult> {
  const accountId = normalizeAccountId(opts.accountId);
  const body = buildCreateCampaignBody(opts);

  const result = await graphRequestWithRetry<{ id: string }>(
    `/${accountId}/campaigns`,
    token,
    { method: 'POST', body },
  );

  return {
    id: result.id,
    name: opts.name,
    status: opts.status ?? 'PAUSED',
    objective: opts.objective,
  };
}

export function buildUpdateCampaignBody(opts: UpdateCampaignOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name) body['name'] = opts.name;
  if (opts.status) body['status'] = opts.status;
  if (opts.dailyBudget) body['daily_budget'] = opts.dailyBudget;
  if (opts.lifetimeBudget) body['lifetime_budget'] = opts.lifetimeBudget;
  return body;
}

export function dryRunUpdateCampaign(opts: UpdateCampaignOptions): DryRunResult {
  return {
    dry_run: true,
    method: 'POST',
    path: `/${opts.campaignId}`,
    body: buildUpdateCampaignBody(opts),
  };
}

export async function updateCampaign(
  token: string,
  opts: UpdateCampaignOptions,
): Promise<UpdateResult> {
  const body = buildUpdateCampaignBody(opts);

  const result = await graphRequestWithRetry<{ success: boolean }>(
    `/${opts.campaignId}`,
    token,
    { method: 'POST', body },
  );

  return {
    id: opts.campaignId,
    updated: result.success ?? true,
    changes: body,
  };
}
