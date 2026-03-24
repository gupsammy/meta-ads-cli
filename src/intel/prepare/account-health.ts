import type { CampaignSummary, IntelConfig, AccountHealth } from '../types.js';
import { round2 } from '../metrics.js';

/**
 * Compute per-objective account health KPIs from campaign summaries.
 * Port of prepare-analysis.sh lines 78-222.
 *
 * Pure function — no file I/O. All KPIs use round2(), vs_target uses Math.round().
 */
export function computeAccountHealth(campaigns: CampaignSummary[], config: IntelConfig): AccountHealth {
  const targets = config.targets ?? {};
  const objectives = [...new Set(campaigns.map((c) => c.objective))].sort();

  // Validate primary_objective: fall back to highest-spend if not in data
  let primaryObjective = config.primary_objective;
  if (!objectives.includes(primaryObjective)) {
    const spendByObj: Record<string, number> = {};
    for (const c of campaigns) {
      spendByObj[c.objective] = (spendByObj[c.objective] ?? 0) + c.spend;
    }
    const sorted = Object.entries(spendByObj).sort((a, b) => b[1] - a[1]);
    primaryObjective = sorted[0]?.[0] ?? config.primary_objective;
  }

  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0);
  const totalReach = campaigns.reduce((s, c) => s + c.reach, 0);

  const result: AccountHealth = {
    account_name: config.account_name,
    currency: config.currency,
    primary_objective: primaryObjective,
    objectives_present: objectives,
    total_spend: totalSpend,
    total_impressions: totalImpressions,
    total_reach: totalReach,
  };

  for (const obj of objectives) {
    const group = campaigns.filter((c) => c.objective === obj);
    const objTargets = targets[obj] ?? {};
    const spend = group.reduce((s, c) => s + c.spend, 0);
    const imp = group.reduce((s, c) => s + c.impressions, 0);
    const rch = group.reduce((s, c) => s + c.reach, 0);

    const base: Record<string, number | string | null> = {
      campaign_count: group.length,
      spend,
      impressions: imp,
      reach: rch,
    };

    if (obj === 'OUTCOME_SALES') {
      const p = group.reduce((s, c) => s + c.purchases, 0);
      const r = group.reduce((s, c) => s + c.revenue, 0);
      const tCpa = objTargets.cpa ?? 0;
      const tRoas = objTargets.roas ?? 0;
      const cpa = p > 0 ? round2(spend / p) : null;
      const roas = spend > 0 ? round2(r / spend) : null;
      Object.assign(base, {
        purchases: p,
        revenue: r,
        cpa,
        roas,
        target_cpa: tCpa,
        target_roas: tRoas,
        cpa_vs_target: p > 0 && tCpa > 0 ? Math.round(((spend / p) - tCpa) / tCpa * 100) : null,
        roas_vs_target: spend > 0 && tRoas > 0 ? Math.round(((r / spend) - tRoas) / tRoas * 100) : null,
      });
    } else if (obj === 'OUTCOME_TRAFFIC') {
      const lc = group.reduce((s, c) => s + c.link_clicks, 0);
      const lpv = group.reduce((s, c) => s + c.landing_page_views, 0);
      const tCpc = objTargets.cpc ?? 0;
      const tCtr = objTargets.ctr ?? objTargets.target_ctr ?? 0;
      const cpc = lc > 0 ? round2(spend / lc) : null;
      const ctr = imp > 0 ? round2(lc / imp * 100) : null;
      Object.assign(base, {
        link_clicks: lc,
        landing_page_views: lpv,
        cpc,
        ctr,
        target_cpc: tCpc,
        target_ctr: tCtr,
        cpc_vs_target: lc > 0 && tCpc > 0 ? Math.round(((spend / lc) - tCpc) / tCpc * 100) : null,
        ctr_vs_target: imp > 0 && tCtr > 0 ? Math.round(((lc / imp * 100) - tCtr) / tCtr * 100) : null,
      });
    } else if (obj === 'OUTCOME_AWARENESS') {
      const vv = group.reduce((s, c) => s + c.video_view, 0);
      const tCpm = objTargets.cpm ?? 0;
      const tCpv = objTargets.cpv ?? 0;
      const tFreq = objTargets.max_frequency ?? (targets.global?.max_frequency ?? 5.0);
      const cpm = imp > 0 ? round2(spend / imp * 1000) : null;
      const avgFreq = rch > 0 ? round2(imp / rch) : null;
      const reachRate = imp > 0 ? round2(rch / imp * 100) : null;
      const cpv = vv > 0 ? round2(spend / vv) : null;
      Object.assign(base, {
        cpm,
        avg_frequency: avgFreq,
        reach_rate: reachRate,
        video_views: vv,
        cpv,
        target_cpm: tCpm,
        target_cpv: tCpv,
        target_max_frequency: tFreq,
        cpm_vs_target: imp > 0 && tCpm > 0 ? Math.round(((spend / imp * 1000) - tCpm) / tCpm * 100) : null,
        cpv_vs_target: vv > 0 && tCpv > 0 ? Math.round(((spend / vv) - tCpv) / tCpv * 100) : null,
      });
    } else if (obj === 'OUTCOME_ENGAGEMENT') {
      const pe = group.reduce((s, c) => s + c.post_engagement, 0);
      const pge = group.reduce((s, c) => s + c.page_engagement, 0);
      const tCpe = objTargets.cpe ?? 0;
      const tEr = objTargets.engagement_rate ?? objTargets.target_engagement_rate ?? 0;
      const cpe = pe > 0 ? round2(spend / pe) : null;
      const engRate = imp > 0 ? round2(pe / imp * 100) : null;
      Object.assign(base, {
        post_engagement: pe,
        page_engagement: pge,
        cpe,
        engagement_rate: engRate,
        target_cpe: tCpe,
        target_engagement_rate: tEr,
        cpe_vs_target: pe > 0 && tCpe > 0 ? Math.round(((spend / pe) - tCpe) / tCpe * 100) : null,
      });
    } else if (obj === 'OUTCOME_LEADS') {
      const ld = group.reduce((s, c) => s + c.lead, 0);
      const tCpl = objTargets.cpl ?? 0;
      const cpl = ld > 0 ? round2(spend / ld) : null;
      Object.assign(base, {
        leads: ld,
        cpl,
        target_cpl: tCpl,
        cpl_vs_target: ld > 0 && tCpl > 0 ? Math.round(((spend / ld) - tCpl) / tCpl * 100) : null,
      });
    } else if (obj === 'OUTCOME_APP_PROMOTION') {
      const ai = group.reduce((s, c) => s + c.app_install, 0);
      const tCpi = objTargets.cpi ?? 0;
      const cpi = ai > 0 ? round2(spend / ai) : null;
      Object.assign(base, {
        app_installs: ai,
        cpi,
        target_cpi: tCpi,
        cpi_vs_target: ai > 0 && tCpi > 0 ? Math.round(((spend / ai) - tCpi) / tCpi * 100) : null,
      });
    }

    result[obj] = base as AccountHealth[string];
  }

  return result;
}
