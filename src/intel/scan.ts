import { paginateAll } from '../lib/http.js';
import { attrGuard, omniFirst, round2 } from './metrics.js';
import { normalizeObjective } from './objective-map.js';
import type { InsightsRow, ScanResult, ScanAdEntry, ScanObjectiveGroup, FormatBreakdown } from './types.js';

const SCAN_FIELDS =
  'ad_id,ad_name,campaign_id,campaign_name,spend,impressions,reach,cpc,ctr,cpm,actions,action_values,purchase_roas';

interface AdRow {
  id: string;
  name?: string;
  creative?: {
    id?: string;
    title?: string;
    body?: string;
    image_url?: string;
    thumbnail_url?: string;
  };
}

interface CampaignRow {
  id: string;
  objective?: string;
}

interface CreativeInfo {
  creative_body: string;
  creative_title: string;
  creative_image_url: string;
  creative_thumbnail_url: string;
}

interface JoinedAd {
  ad_name: string | null;
  campaign_name: string | null;
  objective: string;
  spend: number;
  impressions: number;
  reach: number;
  cpc: number;
  ctr: number;
  cpm: number;
  link_clicks: number;
  purchases: number;
  revenue: number;
  roas: number;
  post_engagement: number;
  lead: number;
  app_install: number;
  creative_body: string;
  creative_title: string;
  cpa: number | null;
  cpe: number | null;
  cpl: number | null;
  cpi: number | null;
  link_click_ctr: number;
  link_click_cpc: number | null;
  format: 'video' | 'image' | 'unknown';
  has_conversion: boolean;
  sort_metric: number;
}

/**
 * Creative scan for onboarding — ranks ads by objective-appropriate metric.
 * Port of onboard-scan.sh — fetches ad-level insights, ads with creatives,
 * and campaigns in parallel, then joins and ranks per objective.
 * @param accountId Full account ID with act_ prefix (e.g. "act_123456")
 */
export async function creativeScan(
  accountId: string,
  accessToken: string,
): Promise<ScanResult> {
  // 1. Parallel fetch: insights (paginated), ads with creatives, campaigns
  const [insightsResult, adsResult, campaignsResult] = await Promise.all([
    paginateAll<InsightsRow>(
      `/${accountId}/insights`,
      accessToken,
      { params: { date_preset: 'last_14d', level: 'ad', fields: SCAN_FIELDS, limit: '200' } },
    ),
    paginateAll<AdRow>(
      `/${accountId}/ads`,
      accessToken,
      { params: { fields: 'id,name,creative{id,title,body,image_url,thumbnail_url}', limit: '200' } },
    ),
    paginateAll<CampaignRow>(
      `/${accountId}/campaigns`,
      accessToken,
      { params: { fields: 'id,objective', limit: '200' } },
    ),
  ]);

  // 2. Build creative lookup: ad_id → creative fields
  const creativeLookup = new Map<string, CreativeInfo>();
  for (const ad of adsResult.data) {
    creativeLookup.set(String(ad.id), {
      creative_body: ad.creative?.body ?? '',
      creative_title: ad.creative?.title ?? '',
      creative_image_url: ad.creative?.image_url ?? '',
      creative_thumbnail_url: ad.creative?.thumbnail_url ?? '',
    });
  }

  // 3. Build objective lookup: campaign_id → normalized objective
  const objLookup = new Map<string, string>();
  for (const c of campaignsResult.data) {
    objLookup.set(String(c.id), normalizeObjective(c.objective ?? 'UNKNOWN'));
  }

  // 4. Join insights with lookups, compute metrics
  const rows = insightsResult.data;
  const joined: JoinedAd[] = rows.map((row) => {
    const aid = String(row.ad_id ?? '');
    const cid = String(row.campaign_id ?? '');
    const actions = attrGuard(row.actions);
    const actionVals = attrGuard(row.action_values);
    const purchaseRoas = attrGuard(row.purchase_roas);

    const creative = aid ? creativeLookup.get(aid) : undefined;
    const objective = objLookup.get(cid) ?? 'UNKNOWN';

    const spend = parseFloat(String(row.spend ?? '0')) || 0;
    const impressions = parseFloat(String(row.impressions ?? '0')) || 0;
    const reach = parseFloat(String(row.reach ?? '0')) || 0;
    const cpc = parseFloat(String(row.cpc ?? '0')) || 0;
    const ctr = parseFloat(String(row.ctr ?? '0')) || 0;
    const cpm = parseFloat(String(row.cpm ?? '0')) || 0;
    const link_clicks = omniFirst(actions, ['link_click']);
    const purchases = omniFirst(actions, ['omni_purchase', 'purchase']);
    const revenue = omniFirst(actionVals, ['omni_purchase', 'purchase']);
    const roas = omniFirst(purchaseRoas, ['omni_purchase', 'purchase']);
    const post_engagement = omniFirst(actions, ['post_engagement']);
    const lead = omniFirst(actions, ['onsite_conversion.lead_grouped', 'lead']);
    const app_install = omniFirst(actions, ['omni_app_install', 'mobile_app_install', 'app_install']);

    // Cost-per metrics left unrounded — matches shell's add_derived which defers
    // rounding to prepare-analysis.sh downstream
    const cpa = purchases > 0 ? spend / purchases : null;
    const cpe = post_engagement > 0 ? spend / post_engagement : null;
    const cpl = lead > 0 ? spend / lead : null;
    const cpi = app_install > 0 ? spend / app_install : null;
    const link_click_ctr = impressions > 0 ? round2(link_clicks / impressions * 100) : 0;
    const link_click_cpc = link_clicks > 0 ? round2(spend / link_clicks) : null;

    const hasThumbnail = creative ? creative.creative_thumbnail_url !== '' : false;
    const hasImage = creative ? creative.creative_image_url !== '' : false;
    const format: 'video' | 'image' | 'unknown' = hasThumbnail ? 'video' : hasImage ? 'image' : 'unknown';

    const has_conversion = computeHasConversion(objective, { purchases, link_clicks, post_engagement, lead, app_install, reach, spend });
    const sort_metric = computeSortMetric(objective, { roas, link_click_ctr, cpe, cpl, cpi, cpm, spend });

    return {
      ad_name: row.ad_name != null ? String(row.ad_name) : null,
      campaign_name: row.campaign_name != null ? String(row.campaign_name) : null,
      objective,
      spend, impressions, reach, cpc, ctr, cpm,
      link_clicks, purchases, revenue, roas,
      post_engagement, lead, app_install,
      creative_body: creative?.creative_body ?? '',
      creative_title: creative?.creative_title ?? '',
      cpa, cpe, cpl, cpi, link_click_ctr, link_click_cpc,
      format, has_conversion, sort_metric,
    };
  });

  // 5. Group by objective, rank within each
  const groups = new Map<string, JoinedAd[]>();
  for (const ad of joined) {
    const list = groups.get(ad.objective) ?? [];
    list.push(ad);
    groups.set(ad.objective, list);
  }

  const byObjective: Record<string, ScanObjectiveGroup> = {};
  const allObjectives: string[] = [];

  for (const [obj, ads] of groups) {
    allObjectives.push(obj);
    const ranked = ads
      .filter((a) => a.has_conversion)
      .sort((a, b) => b.sort_metric - a.sort_metric);
    const total = ranked.length;
    const winN = Math.min(5, Math.max(1, Math.floor(total / 2)));
    const loseN = Math.min(5, Math.max(0, total - winN));

    byObjective[obj] = {
      winners: ranked.slice(0, winN).map(toEntry),
      losers: loseN > 0 ? ranked.slice(-loseN).map(toEntry) : [],
      total_ads: ads.length,
      ads_with_conversions: total,
    };
  }

  // 6. Format breakdown across ALL ads
  const formatBreakdown = computeFormatBreakdown(joined);

  return {
    by_objective: byObjective,
    format_breakdown: formatBreakdown,
    objectives_detected: allObjectives.sort(),
    total_ads: joined.length,
  };
}

function toEntry(ad: JoinedAd): ScanAdEntry {
  return {
    ad_name: ad.ad_name,
    campaign_name: ad.campaign_name,
    objective: ad.objective,
    roas: ad.roas,
    cpa: ad.cpa,
    cpc: ad.cpc,
    ctr: ad.ctr,
    link_click_ctr: ad.link_click_ctr,
    link_click_cpc: ad.link_click_cpc,
    cpe: ad.cpe,
    cpl: ad.cpl,
    cpi: ad.cpi,
    creative_body: ad.creative_body,
    creative_title: ad.creative_title,
    format: ad.format,
  };
}

function computeHasConversion(
  obj: string,
  m: { purchases: number; link_clicks: number; post_engagement: number; lead: number; app_install: number; reach: number; spend: number },
): boolean {
  switch (obj) {
    case 'OUTCOME_SALES': return m.purchases > 0;
    case 'OUTCOME_TRAFFIC': return m.link_clicks > 0;
    case 'OUTCOME_ENGAGEMENT': return m.post_engagement > 0;
    case 'OUTCOME_LEADS': return m.lead > 0;
    case 'OUTCOME_APP_PROMOTION': return m.app_install > 0;
    case 'OUTCOME_AWARENESS': return m.reach > 0;
    default: return m.spend > 0;
  }
}

function computeSortMetric(
  obj: string,
  m: { roas: number; link_click_ctr: number; cpe: number | null; cpl: number | null; cpi: number | null; cpm: number; spend: number },
): number {
  switch (obj) {
    case 'OUTCOME_SALES': return m.roas;
    case 'OUTCOME_TRAFFIC': return m.link_click_ctr;
    case 'OUTCOME_ENGAGEMENT': return m.cpe != null && m.cpe > 0 ? 1 / m.cpe : 0;
    case 'OUTCOME_LEADS': return m.cpl != null && m.cpl > 0 ? 1 / m.cpl : 0;
    case 'OUTCOME_APP_PROMOTION': return m.cpi != null && m.cpi > 0 ? 1 / m.cpi : 0;
    case 'OUTCOME_AWARENESS': return m.cpm > 0 ? 1 / m.cpm : 0;
    default: return m.spend;
  }
}

function computeFormatBreakdown(ads: JoinedAd[]): FormatBreakdown {
  let video = 0, image = 0, unknown = 0;
  for (const ad of ads) {
    if (ad.format === 'video') video++;
    else if (ad.format === 'image') image++;
    else unknown++;
  }
  const total = ads.length;
  const confidence: FormatBreakdown['confidence'] =
    total === 0 ? 'n/a' : unknown / total > 0.3 ? 'low' : 'high';
  return { video, image, unknown, confidence };
}
