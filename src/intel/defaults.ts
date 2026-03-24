import { paginateAll } from '../lib/http.js';
import { extractMetrics, round2 } from './metrics.js';
import { normalizeObjective } from './objective-map.js';
import type { InsightsRow, ExtractedMetrics, DefaultsResult, ObjectiveDefaults } from './types.js';

const DEFAULTS_FIELDS =
  'campaign_id,spend,impressions,clicks,cpc,ctr,cpm,reach,frequency,actions,action_values,purchase_roas';

interface CampaignRow {
  id: string;
  objective?: string;
}

/**
 * Compute per-objective KPI defaults from campaign-level insights (last 14 days).
 * Port of compute-defaults.sh — groups campaigns by normalized objective and
 * computes objective-specific KPIs used to seed config targets.
 * @param accountId Full account ID with act_ prefix (e.g. "act_123456")
 */
export async function computeDefaults(
  accountId: string,
  accessToken: string,
): Promise<DefaultsResult> {
  // 1. Fetch campaigns to build objective lookup
  const campaignsResult = await paginateAll<CampaignRow>(
    `/${accountId}/campaigns`,
    accessToken,
    { params: { fields: 'id,objective', limit: '200' } },
  );
  const objLookup = new Map<string, string>();
  for (const c of campaignsResult.data) {
    objLookup.set(String(c.id), normalizeObjective(c.objective ?? 'UNKNOWN'));
  }

  // 2. Fetch campaign-level insights (paginated to handle >200 campaigns)
  const insightsResult = await paginateAll<InsightsRow>(
    `/${accountId}/insights`,
    accessToken,
    { params: { date_preset: 'last_14d', level: 'campaign', fields: DEFAULTS_FIELDS, limit: '200' } },
  );
  const rows = insightsResult.data;

  // 3. Extract metrics and attach objective
  const enriched = rows.map((row) => {
    const cid = String(row.campaign_id ?? '');
    return {
      ...extractMetrics(row),
      campaign_id: cid,
      objective: objLookup.get(cid) ?? 'UNKNOWN',
    };
  });

  // 4. Group by objective
  const groups = new Map<string, EnrichedEntry[]>();
  for (const entry of enriched) {
    const list = groups.get(entry.objective) ?? [];
    list.push(entry);
    groups.set(entry.objective, list);
  }

  const totalSpend = enriched.reduce((s, e) => s + e.spend, 0);

  // 5. Compute per-objective KPIs
  const objectives: DefaultsResult['objectives'] = {};
  for (const [obj, entries] of groups) {
    const spend = entries.reduce((s, e) => s + e.spend, 0);
    const base = { campaign_count: entries.length, spend: round2(spend) };
    objectives[obj] = { ...base, ...computeKpis(obj, entries) };
  }

  return {
    objectives,
    total_spend: round2(totalSpend),
    objectives_detected: [...groups.keys()].sort(),
  };
}

type EnrichedEntry = ExtractedMetrics & { campaign_id: string; objective: string };

function sum(entries: EnrichedEntry[], field: keyof ExtractedMetrics): number {
  return entries.reduce((s, e) => s + e[field], 0);
}

function computeKpis(obj: string, entries: EnrichedEntry[]): ObjectiveDefaults {
  const spend = sum(entries, 'spend');

  switch (obj) {
    case 'OUTCOME_SALES': {
      const p = sum(entries, 'purchases');
      const r = sum(entries, 'revenue');
      return {
        purchases: p,
        revenue: round2(r),
        current_cpa: p > 0 ? round2(spend / p) : null,
        current_roas: spend > 0 ? round2(r / spend) : null,
      };
    }
    case 'OUTCOME_TRAFFIC': {
      const lc = sum(entries, 'link_clicks');
      const lpv = sum(entries, 'landing_page_views');
      const imp = sum(entries, 'impressions');
      return {
        link_clicks: lc,
        landing_page_views: lpv,
        current_cpc: lc > 0 ? round2(spend / lc) : null,
        current_link_ctr: imp > 0 ? round2(lc / imp * 100) : null,
      };
    }
    case 'OUTCOME_AWARENESS': {
      const imp = sum(entries, 'impressions');
      const rch = sum(entries, 'reach');
      const vv = sum(entries, 'video_view');
      return {
        impressions: imp,
        reach: rch,
        video_views: vv,
        current_cpm: imp > 0 ? round2(spend / imp * 1000) : null,
        current_cpv: vv > 0 ? round2(spend / vv) : null,
        avg_frequency: rch > 0 ? round2(imp / rch) : null,
      };
    }
    case 'OUTCOME_ENGAGEMENT': {
      const pe = sum(entries, 'post_engagement');
      const imp = sum(entries, 'impressions');
      return {
        post_engagement: pe,
        current_cpe: pe > 0 ? round2(spend / pe) : null,
        engagement_rate: imp > 0 ? round2(pe / imp * 100) : null,
      };
    }
    case 'OUTCOME_LEADS': {
      const ld = sum(entries, 'lead');
      return {
        leads: ld,
        current_cpl: ld > 0 ? round2(spend / ld) : null,
      };
    }
    case 'OUTCOME_APP_PROMOTION': {
      const ai = sum(entries, 'app_install');
      return {
        app_installs: ai,
        current_cpi: ai > 0 ? round2(spend / ai) : null,
      };
    }
    default:
      return {};
  }
}
