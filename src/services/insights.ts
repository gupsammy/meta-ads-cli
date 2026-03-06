import { graphRequestWithRetry, type GraphApiResponse } from '../lib/http.js';
import { normalizeAccountId } from './accounts.js';
import type { InsightRow, GetInsightsOptions } from './types.js';

const INSIGHT_FIELDS = 'account_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,action_values,cost_per_action_type,purchase_roas,date_start,date_stop';

export class InsightsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsightsValidationError';
  }
}

export function resolveInsightsPath(opts: GetInsightsOptions): string {
  if (opts.adId) return `/${opts.adId}/insights`;
  if (opts.adsetId) return `/${opts.adsetId}/insights`;
  if (opts.campaignId) return `/${opts.campaignId}/insights`;
  if (opts.accountId) {
    const accountId = normalizeAccountId(opts.accountId);
    return `/${accountId}/insights`;
  }
  throw new InsightsValidationError('Specify at least one of: accountId, campaignId, adsetId, adId');
}

export function resolveInsightsLevel(opts: GetInsightsOptions): string {
  return opts.level ?? (opts.adId ? 'ad' : opts.adsetId ? 'adset' : opts.campaignId ? 'campaign' : 'account');
}

export async function getInsights(
  token: string,
  opts: GetInsightsOptions,
): Promise<InsightRow[]> {
  const basePath = resolveInsightsPath(opts);

  if ((opts.since && !opts.until) || (!opts.since && opts.until)) {
    throw new InsightsValidationError('--since and --until must both be specified together');
  }

  const level = resolveInsightsLevel(opts);

  const params: Record<string, string> = {
    fields: opts.fields ?? INSIGHT_FIELDS,
    level,
  };

  if (opts.datePreset) params['date_preset'] = opts.datePreset;
  if (opts.since && opts.until) {
    params['time_range'] = JSON.stringify({ since: opts.since, until: opts.until });
  }
  if (opts.timeIncrement) params['time_increment'] = opts.timeIncrement;
  if (opts.limit) params['limit'] = opts.limit;

  const response = await graphRequestWithRetry<GraphApiResponse<InsightRow>>(
    basePath,
    token,
    { params },
  );

  return response.data ?? [];
}
