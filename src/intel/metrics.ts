import type { ActionEntry, InsightsRow, ExtractedMetrics, DerivedMetrics } from './types.js';

/** Round to 2 decimal places — matches jq's `* 100 | round / 100` */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Filter out entries with action_attribution_window.
 * Falls back to original array if filtering removes everything.
 * Handles null/undefined input (returns []).
 */
export function attrGuard(actions: ActionEntry[] | null | undefined): ActionEntry[] {
  const raw = actions ?? [];
  const filtered = raw.filter((e) => !('action_attribution_window' in e));
  return filtered.length === 0 ? raw : filtered;
}

/**
 * Pick the first matching action_type from a priority list.
 * Returns numeric value of first match, or 0 if none.
 */
export function omniFirst(actions: ActionEntry[], types: string[]): number {
  const matches = actions.filter((e) => types.includes(e.action_type));
  if (matches.length === 0) return 0;
  matches.sort((a, b) => types.indexOf(a.action_type) - types.indexOf(b.action_type));
  return parseFloat(String(matches[0].value)) || 0;
}

/**
 * Extract 21 flat numeric fields from a raw insights row.
 * Port of jq-defs.sh extract_metrics — applies attrGuard then omniFirst
 * with hardcoded priority lists per metric.
 */
export function extractMetrics(row: InsightsRow): ExtractedMetrics {
  const actions = attrGuard(row.actions);
  const actionVals = attrGuard(row.action_values);
  const purchaseRoas = attrGuard(row.purchase_roas);

  return {
    spend: parseFloat(String(row.spend ?? '0')) || 0,
    impressions: parseFloat(String(row.impressions ?? '0')) || 0,
    clicks: parseFloat(String(row.clicks ?? '0')) || 0,
    cpc: parseFloat(String(row.cpc ?? '0')) || 0,
    ctr: parseFloat(String(row.ctr ?? '0')) || 0,
    cpm: parseFloat(String(row.cpm ?? '0')) || 0,
    frequency: parseFloat(String(row.frequency ?? '0')) || 0,
    reach: parseFloat(String(row.reach ?? '0')) || 0,
    purchases: omniFirst(actions, ['omni_purchase', 'purchase']),
    revenue: omniFirst(actionVals, ['omni_purchase', 'purchase']),
    roas: omniFirst(purchaseRoas, ['omni_purchase', 'purchase']),
    add_to_cart: omniFirst(actions, ['omni_add_to_cart', 'add_to_cart']),
    initiate_checkout: omniFirst(actions, ['omni_initiated_checkout', 'initiate_checkout']),
    view_content: omniFirst(actions, ['omni_view_content', 'view_content']),
    link_clicks: omniFirst(actions, ['link_click']),
    landing_page_views: omniFirst(actions, ['landing_page_view']),
    post_engagement: omniFirst(actions, ['post_engagement']),
    page_engagement: omniFirst(actions, ['page_engagement']),
    lead: omniFirst(actions, ['onsite_conversion.lead_grouped', 'lead']),
    app_install: omniFirst(actions, ['omni_app_install', 'mobile_app_install', 'app_install']),
    video_view: omniFirst(actions, ['video_view']),
  };
}

/**
 * Add 6 derived fields to extracted metrics.
 * Nullable fields return null when divisor is 0; link_click_ctr returns 0 instead.
 */
export function addDerived(metrics: ExtractedMetrics): DerivedMetrics {
  return {
    ...metrics,
    cpa: metrics.purchases > 0 ? metrics.spend / metrics.purchases : null,
    cpe: metrics.post_engagement > 0 ? metrics.spend / metrics.post_engagement : null,
    cpl: metrics.lead > 0 ? metrics.spend / metrics.lead : null,
    cpi: metrics.app_install > 0 ? metrics.spend / metrics.app_install : null,
    link_click_ctr: metrics.impressions > 0 ? round2(metrics.link_clicks / metrics.impressions * 100) : 0,
    link_click_cpc: metrics.link_clicks > 0 ? round2(metrics.spend / metrics.link_clicks) : null,
  };
}
