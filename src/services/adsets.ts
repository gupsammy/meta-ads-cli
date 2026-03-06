import { paginateAll, graphRequestWithRetry } from '../lib/http.js';
import type { PaginatedResult } from '../lib/http.js';
import { normalizeAccountId } from './accounts.js';
import type {
  AdSetListItem,
  AdSetDetail,
  ListAdSetsOptions,
  CreateAdSetOptions,
  CreateAdSetResult,
  UpdateAdSetOptions,
  UpdateResult,
  DryRunResult,
} from './types.js';

interface RawAdSet {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  campaign_id: string;
  daily_budget?: string;
  lifetime_budget?: string;
  billing_event: string;
  optimization_goal: string;
  bid_amount?: string;
  targeting?: Record<string, unknown>;
  created_time: string;
  updated_time: string;
  start_time?: string;
  end_time?: string;
}

const ADSET_FIELDS = 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,billing_event,optimization_goal,bid_amount,created_time,updated_time,start_time,end_time';

export async function listAdSets(
  token: string,
  opts: ListAdSetsOptions,
): Promise<PaginatedResult<AdSetListItem>> {
  const accountId = normalizeAccountId(opts.accountId);
  const params: Record<string, string> = { fields: ADSET_FIELDS };
  if (opts.after) params['after'] = opts.after;

  const filtering: Array<{ field: string; operator: string; value: string[] }> = [];
  if (opts.status) {
    filtering.push({ field: 'effective_status', operator: 'IN', value: [opts.status] });
  }
  if (opts.campaignId) {
    filtering.push({ field: 'campaign_id', operator: 'EQUAL', value: [opts.campaignId] });
  }
  if (filtering.length > 0) {
    params['filtering'] = JSON.stringify(filtering);
  }

  const limit = opts.limit ?? 50;

  const result = await paginateAll<RawAdSet>(
    `/${accountId}/adsets`,
    token,
    { params },
    limit,
  );

  return {
    data: result.data.map((a) => ({
      id: a.id,
      name: a.name,
      campaign_id: a.campaign_id,
      status: a.status,
      effective_status: a.effective_status,
      billing_event: a.billing_event,
      optimization_goal: a.optimization_goal,
      daily_budget: a.daily_budget ?? '',
      created_time: a.created_time,
    })),
    has_more: result.has_more,
    next_cursor: result.next_cursor,
  };
}

export async function getAdSet(
  token: string,
  adsetId: string,
): Promise<AdSetDetail> {
  const fields = ADSET_FIELDS + ',targeting';
  const params: Record<string, string> = { fields };

  const a = await graphRequestWithRetry<RawAdSet>(`/${adsetId}`, token, { params });

  return {
    id: a.id,
    name: a.name,
    campaign_id: a.campaign_id,
    status: a.status,
    effective_status: a.effective_status,
    billing_event: a.billing_event,
    optimization_goal: a.optimization_goal,
    daily_budget: a.daily_budget ?? '',
    lifetime_budget: a.lifetime_budget ?? '',
    bid_amount: a.bid_amount ?? '',
    targeting: a.targeting ? JSON.stringify(a.targeting) : '',
    created_time: a.created_time,
    updated_time: a.updated_time,
    start_time: a.start_time ?? '',
    end_time: a.end_time ?? '',
  };
}

export function buildCreateAdSetBody(opts: CreateAdSetOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    campaign_id: opts.campaignId,
    name: opts.name,
    billing_event: opts.billingEvent,
    optimization_goal: opts.optimizationGoal,
    status: opts.status ?? 'PAUSED',
  };
  if (opts.dailyBudget) body['daily_budget'] = opts.dailyBudget;
  if (opts.lifetimeBudget) body['lifetime_budget'] = opts.lifetimeBudget;
  if (opts.bidAmount) body['bid_amount'] = opts.bidAmount;
  if (opts.targeting) body['targeting'] = opts.targeting;
  if (opts.startTime) body['start_time'] = opts.startTime;
  if (opts.endTime) body['end_time'] = opts.endTime;
  return body;
}

export function dryRunCreateAdSet(opts: CreateAdSetOptions): DryRunResult {
  const accountId = normalizeAccountId(opts.accountId);
  return {
    dry_run: true,
    method: 'POST',
    path: `/${accountId}/adsets`,
    body: buildCreateAdSetBody(opts),
  };
}

export async function createAdSet(
  token: string,
  opts: CreateAdSetOptions,
): Promise<CreateAdSetResult> {
  const accountId = normalizeAccountId(opts.accountId);
  const body = buildCreateAdSetBody(opts);

  const result = await graphRequestWithRetry<{ id: string }>(
    `/${accountId}/adsets`,
    token,
    { method: 'POST', body },
  );

  return {
    id: result.id,
    name: opts.name,
    campaign_id: opts.campaignId,
    status: opts.status ?? 'PAUSED',
  };
}

export function buildUpdateAdSetBody(opts: UpdateAdSetOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.name) body['name'] = opts.name;
  if (opts.status) body['status'] = opts.status;
  if (opts.dailyBudget) body['daily_budget'] = opts.dailyBudget;
  if (opts.lifetimeBudget) body['lifetime_budget'] = opts.lifetimeBudget;
  if (opts.bidAmount) body['bid_amount'] = opts.bidAmount;
  if (opts.targeting) body['targeting'] = opts.targeting;
  return body;
}

export function dryRunUpdateAdSet(opts: UpdateAdSetOptions): DryRunResult {
  return {
    dry_run: true,
    method: 'POST',
    path: `/${opts.adsetId}`,
    body: buildUpdateAdSetBody(opts),
  };
}

export async function updateAdSet(
  token: string,
  opts: UpdateAdSetOptions,
): Promise<UpdateResult> {
  const body = buildUpdateAdSetBody(opts);

  const result = await graphRequestWithRetry<{ success: boolean }>(
    `/${opts.adsetId}`,
    token,
    { method: 'POST', body },
  );

  return {
    id: opts.adsetId,
    updated: result.success ?? true,
    changes: body,
  };
}
