import type { CampaignSummary, TrendsData, TrendCampaign } from '../types.js';
import { round2 } from '../metrics.js';

/**
 * Compute prior vs recent window deltas per campaign with deterioration flags.
 * Port of prepare-analysis.sh lines 589-743.
 *
 * Pure function — takes full-period and recent-window campaign summaries.
 * Returns {available: false} when recent data is missing or period is too short.
 */
export function computeTrends(campaigns: CampaignSummary[], recentCampaigns: CampaignSummary[] | null): TrendsData {
  if (!recentCampaigns || recentCampaigns.length === 0) {
    return { available: false, reason: 'no recent window data' };
  }

  const periodStart = campaigns.length > 0 ? campaigns[0].date_start : null;
  const periodStop = campaigns.length > 0 ? campaigns[0].date_stop : null;
  const recentStart = recentCampaigns.length > 0 ? recentCampaigns[0].date_start : null;
  const recentStop = recentCampaigns.length > 0 ? recentCampaigns[0].date_stop : null;

  if (periodStart === recentStart) {
    return { available: false, reason: 'period equals recent window' };
  }
  if (periodStart === null || recentStart === null || periodStart >= recentStart) {
    return { available: false, reason: 'period shorter than or equal to recent window' };
  }

  // Build recent lookup by campaign_id
  const recentIdx: Record<string, CampaignSummary> = {};
  for (const r of recentCampaigns) {
    if (r.campaign_id) recentIdx[r.campaign_id] = r;
  }

  const objectives = [...new Set(campaigns.map((c) => c.objective))].sort();

  const trendCampaigns: TrendCampaign[] = [];

  for (const c of campaigns) {
    if (c.campaign_id === null) continue;
    const r = recentIdx[c.campaign_id];
    if (!r) continue;

    // Compute prior window by subtracting recent from full period (clamped to 0)
    const priorSpend = Math.max(0, c.spend - r.spend);
    const priorImp = Math.max(0, c.impressions - r.impressions);
    const priorPurchases = Math.max(0, c.purchases - r.purchases);
    const priorRevenue = Math.max(0, c.revenue - r.revenue);
    const priorLinkClicks = Math.max(0, c.link_clicks - r.link_clicks);
    const priorPostEng = Math.max(0, c.post_engagement - r.post_engagement);
    const priorLead = Math.max(0, c.lead - r.lead);
    const priorAppInstall = Math.max(0, c.app_install - r.app_install);
    const priorVideoView = Math.max(0, c.video_view - r.video_view);

    // Recompute derived rates from prior-window bases
    const priorCpa = priorPurchases > 0 ? priorSpend / priorPurchases : null;
    const priorRoas = priorSpend > 0 && priorRevenue > 0 ? priorRevenue / priorSpend : 0;
    const priorLinkClickCtr = priorImp > 0 ? priorLinkClicks / priorImp * 100 : 0;
    const priorLinkClickCpc = priorLinkClicks > 0 ? priorSpend / priorLinkClicks : null;
    const priorCpm = priorImp > 0 ? priorSpend / priorImp * 1000 : 0;
    const priorCpe = priorPostEng > 0 ? priorSpend / priorPostEng : null;
    const priorCpl = priorLead > 0 ? priorSpend / priorLead : null;
    const priorCpi = priorAppInstall > 0 ? priorSpend / priorAppInstall : null;
    const priorCpv = priorVideoView > 0 ? priorSpend / priorVideoView : null;

    const entry: Record<string, unknown> = {
      campaign_name: c.campaign_name,
      campaign_id: c.campaign_id,
      objective: c.objective,
      prior_spend: priorSpend,
      recent_spend: r.spend,
      period_frequency: round2(c.frequency),
      recent_frequency: r.frequency != null ? round2(r.frequency) : null,
    };

    // Objective-appropriate deltas
    const flags: string[] = [];

    if (c.objective === 'OUTCOME_SALES') {
      const cpaDelta = priorCpa !== null && priorCpa > 0 && r.cpa !== null
        ? Math.round((r.cpa - priorCpa) / priorCpa * 100) : null;
      const roasDelta = priorRoas > 0 && r.roas != null
        ? Math.round((r.roas - priorRoas) / priorRoas * 100) : null;
      Object.assign(entry, {
        prior_cpa: priorCpa,
        recent_cpa: r.cpa,
        prior_roas: round2(priorRoas),
        recent_roas: round2(r.roas),
        cpa_delta_pct: cpaDelta,
        roas_delta_pct: roasDelta,
      });
      if (roasDelta !== null && roasDelta < -15) flags.push('roas_declining');
      if (cpaDelta !== null && cpaDelta > 15) flags.push('cpa_rising');
    } else if (c.objective === 'OUTCOME_TRAFFIC') {
      const cpcDelta = priorLinkClickCpc !== null && priorLinkClickCpc > 0 && r.link_click_cpc !== null
        ? Math.round((r.link_click_cpc - priorLinkClickCpc) / priorLinkClickCpc * 100) : null;
      const ctrDelta = priorLinkClickCtr > 0 && r.link_click_ctr != null
        ? Math.round((r.link_click_ctr - priorLinkClickCtr) / priorLinkClickCtr * 100) : null;
      Object.assign(entry, {
        prior_cpc: priorLinkClickCpc !== null ? round2(priorLinkClickCpc) : null,
        recent_cpc: r.link_click_cpc !== null ? round2(r.link_click_cpc) : null,
        prior_ctr: round2(priorLinkClickCtr),
        recent_ctr: round2(r.link_click_ctr),
        cpc_delta_pct: cpcDelta,
        ctr_delta_pct: ctrDelta,
      });
      if (cpcDelta !== null && cpcDelta > 15) flags.push('cpc_rising');
      if (ctrDelta !== null && ctrDelta < -15) flags.push('ctr_declining');
    } else if (c.objective === 'OUTCOME_AWARENESS') {
      const cpmDelta = priorCpm > 0 && r.cpm != null
        ? Math.round((r.cpm - priorCpm) / priorCpm * 100) : null;
      const recentCpv = r.video_view > 0 ? r.spend / r.video_view : null;
      const cpvDelta = priorCpv !== null && priorCpv > 0 && r.video_view > 0
        ? Math.round(((r.spend / r.video_view) - priorCpv) / priorCpv * 100) : null;
      Object.assign(entry, {
        prior_cpm: round2(priorCpm),
        recent_cpm: round2(r.cpm),
        cpm_delta_pct: cpmDelta,
        prior_cpv: priorCpv !== null ? round2(priorCpv) : null,
        recent_cpv: recentCpv !== null ? round2(recentCpv) : null,
        cpv_delta_pct: cpvDelta,
      });
      if (cpmDelta !== null && cpmDelta > 15) flags.push('cpm_rising');
      if (cpvDelta !== null && cpvDelta > 15) flags.push('cpv_rising');
    } else if (c.objective === 'OUTCOME_ENGAGEMENT') {
      const cpeDelta = priorCpe !== null && priorCpe > 0 && r.cpe !== null
        ? Math.round((r.cpe - priorCpe) / priorCpe * 100) : null;
      Object.assign(entry, {
        prior_cpe: priorCpe !== null ? round2(priorCpe) : null,
        recent_cpe: r.cpe !== null ? round2(r.cpe) : null,
        cpe_delta_pct: cpeDelta,
      });
      if (cpeDelta !== null && cpeDelta > 15) flags.push('cpe_rising');
    } else if (c.objective === 'OUTCOME_LEADS') {
      const cplDelta = priorCpl !== null && priorCpl > 0 && r.cpl !== null
        ? Math.round((r.cpl - priorCpl) / priorCpl * 100) : null;
      Object.assign(entry, {
        prior_cpl: priorCpl !== null ? round2(priorCpl) : null,
        recent_cpl: r.cpl !== null ? round2(r.cpl) : null,
        cpl_delta_pct: cplDelta,
      });
      if (cplDelta !== null && cplDelta > 15) flags.push('cpl_rising');
    } else if (c.objective === 'OUTCOME_APP_PROMOTION') {
      const cpiDelta = priorCpi !== null && priorCpi > 0 && r.cpi !== null
        ? Math.round((r.cpi - priorCpi) / priorCpi * 100) : null;
      Object.assign(entry, {
        prior_cpi: priorCpi !== null ? round2(priorCpi) : null,
        recent_cpi: r.cpi !== null ? round2(r.cpi) : null,
        cpi_delta_pct: cpiDelta,
      });
      if (cpiDelta !== null && cpiDelta > 15) flags.push('cpi_rising');
    }

    entry.flags = flags;
    trendCampaigns.push(entry as typeof trendCampaigns[number]);
  }

  const flagged = trendCampaigns
    .filter((c) => c.flags.length > 0)
    .map((c) => ({ campaign_name: c.campaign_name, objective: c.objective, flags: c.flags }));

  const recentlyInactive = campaigns
    .filter((c) => c.campaign_id !== null && !recentIdx[c.campaign_id!])
    .map((c) => ({
      campaign_name: c.campaign_name,
      campaign_id: c.campaign_id,
      objective: c.objective,
      period_spend: c.spend,
    }));

  return {
    available: true,
    period: { start: periodStart, stop: periodStop },
    recent: { start: recentStart, stop: recentStop },
    objectives_present: objectives,
    campaigns: trendCampaigns,
    flagged,
    recently_inactive: recentlyInactive,
  };
}
