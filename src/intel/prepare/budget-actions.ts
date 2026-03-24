import type { AdsetSummary, IntelConfig, BudgetActions, BudgetActionEntry, BudgetActionGroup } from '../types.js';
import { round2 } from '../metrics.js';

type Action = 'scale' | 'reduce' | 'pause' | 'refresh' | 'maintain';

interface Classification { action: Action; reason: string }

function classifyAdset(a: AdsetSummary, obj: string, targets: Record<string, number>, maxFreq: number): Classification {
  if (a.frequency > maxFreq) {
    return { action: 'refresh', reason: `frequency ${a.frequency} exceeds ceiling ${maxFreq}` };
  }

  if (obj === 'OUTCOME_SALES') {
    const tRoas = targets.roas ?? 0;
    const tCpa = targets.cpa ?? 0;
    if (a.purchases === 0) return { action: 'pause', reason: `zero purchases with spend ${a.spend}` };
    if (tRoas > 0 && tCpa > 0) {
      if (a.roas > tRoas * 1.2 && a.cpa !== null && a.cpa < tCpa * 0.8)
        return { action: 'scale', reason: `ROAS ${round2(a.roas)} above target, CPA ${Math.round(a.cpa)} below target` };
      if (a.roas < tRoas * 0.8 || (a.cpa !== null && a.cpa > tCpa * 1.2))
        return { action: 'reduce', reason: a.roas < tRoas * 0.8 ? `ROAS ${round2(a.roas)} below threshold` : `CPA ${Math.round(a.cpa!)} above threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    if (tRoas > 0) {
      if (a.roas > tRoas * 1.2) return { action: 'scale', reason: `ROAS ${round2(a.roas)} above target` };
      if (a.roas < tRoas * 0.8) return { action: 'reduce', reason: `ROAS ${round2(a.roas)} below threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    if (tCpa > 0) {
      if (a.cpa !== null && a.cpa < tCpa * 0.8) return { action: 'scale', reason: `CPA ${Math.round(a.cpa)} below target` };
      if (a.cpa !== null && a.cpa > tCpa * 1.2) return { action: 'reduce', reason: `CPA ${Math.round(a.cpa)} above threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    return { action: 'maintain', reason: 'no targets set' };
  }

  if (obj === 'OUTCOME_TRAFFIC') {
    const tCpc = targets.cpc ?? 0;
    const tCtr = targets.ctr ?? targets.target_ctr ?? 0;
    if (a.link_clicks === 0) return { action: 'pause', reason: `zero link clicks with spend ${a.spend}` };
    if (tCpc > 0 && tCtr > 0) {
      if (a.link_click_cpc !== null && a.link_click_cpc < tCpc * 0.8 && a.link_click_ctr > tCtr * 1.2)
        return { action: 'scale', reason: `CPC ${round2(a.link_click_cpc)} below target, CTR ${round2(a.link_click_ctr)}% above target` };
      if ((a.link_click_cpc !== null && a.link_click_cpc > tCpc * 1.2) || a.link_click_ctr < tCtr * 0.8)
        return { action: 'reduce', reason: a.link_click_cpc !== null && a.link_click_cpc > tCpc * 1.2
          ? `CPC ${round2(a.link_click_cpc)} above threshold` : `CTR ${round2(a.link_click_ctr)}% below threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    if (tCpc > 0) {
      if (a.link_click_cpc !== null && a.link_click_cpc < tCpc * 0.8) return { action: 'scale', reason: `CPC ${round2(a.link_click_cpc)} below target` };
      if (a.link_click_cpc !== null && a.link_click_cpc > tCpc * 1.2) return { action: 'reduce', reason: `CPC ${round2(a.link_click_cpc)} above threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    if (tCtr > 0) {
      if (a.link_click_ctr > tCtr * 1.2) return { action: 'scale', reason: `CTR ${round2(a.link_click_ctr)}% above target` };
      if (a.link_click_ctr < tCtr * 0.8) return { action: 'reduce', reason: `CTR ${round2(a.link_click_ctr)}% below threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    return { action: 'maintain', reason: 'no targets set' };
  }

  if (obj === 'OUTCOME_AWARENESS') {
    const tCpm = targets.cpm ?? 0;
    const tCpv = targets.cpv ?? 0;
    const cpv = a.video_view > 0 ? a.spend / a.video_view : null;
    if (a.impressions === 0) return { action: 'pause', reason: `zero impressions with spend ${a.spend}` };
    if (tCpm > 0) {
      if (a.cpm < tCpm * 0.8) return { action: 'scale', reason: `CPM ${round2(a.cpm)} below target` };
      if (a.cpm > tCpm * 1.2) return { action: 'reduce', reason: `CPM ${round2(a.cpm)} above threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    if (tCpv > 0 && cpv !== null) {
      if (cpv < tCpv * 0.8) return { action: 'scale', reason: `CPV ${round2(cpv)} below target` };
      if (cpv > tCpv * 1.2) return { action: 'reduce', reason: `CPV ${round2(cpv)} above threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    return { action: 'maintain', reason: 'no targets set' };
  }

  if (obj === 'OUTCOME_ENGAGEMENT') {
    const tCpe = targets.cpe ?? 0;
    if (a.post_engagement === 0) return { action: 'pause', reason: `zero engagement with spend ${a.spend}` };
    if (tCpe > 0) {
      if (a.cpe !== null && a.cpe < tCpe * 0.8) return { action: 'scale', reason: `CPE ${round2(a.cpe)} below target` };
      if (a.cpe !== null && a.cpe > tCpe * 1.2) return { action: 'reduce', reason: `CPE ${round2(a.cpe)} above threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    return { action: 'maintain', reason: 'no targets set' };
  }

  if (obj === 'OUTCOME_LEADS') {
    const tCpl = targets.cpl ?? 0;
    if (a.lead === 0) return { action: 'pause', reason: `zero leads with spend ${a.spend}` };
    if (tCpl > 0) {
      if (a.cpl !== null && a.cpl < tCpl * 0.8) return { action: 'scale', reason: `CPL ${round2(a.cpl)} below target` };
      if (a.cpl !== null && a.cpl > tCpl * 1.2) return { action: 'reduce', reason: `CPL ${round2(a.cpl)} above threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    return { action: 'maintain', reason: 'no targets set' };
  }

  if (obj === 'OUTCOME_APP_PROMOTION') {
    const tCpi = targets.cpi ?? 0;
    if (a.app_install === 0) return { action: 'pause', reason: `zero installs with spend ${a.spend}` };
    if (tCpi > 0) {
      if (a.cpi !== null && a.cpi < tCpi * 0.8) return { action: 'scale', reason: `CPI ${round2(a.cpi)} below target` };
      if (a.cpi !== null && a.cpi > tCpi * 1.2) return { action: 'reduce', reason: `CPI ${round2(a.cpi)} above threshold` };
      return { action: 'maintain', reason: 'within target range' };
    }
    return { action: 'maintain', reason: 'no targets set' };
  }

  return { action: 'maintain', reason: 'unknown objective' };
}

function objectiveFields(a: AdsetSummary, obj: string): Record<string, number | null> {
  if (obj === 'OUTCOME_SALES')
    return { roas: round2(a.roas), cpa: a.cpa !== null ? round2(a.cpa) : null, purchases: a.purchases };
  if (obj === 'OUTCOME_TRAFFIC')
    return { cpc: a.link_click_cpc !== null ? round2(a.link_click_cpc) : null, ctr: round2(a.link_click_ctr), link_clicks: a.link_clicks };
  if (obj === 'OUTCOME_AWARENESS') {
    const cpv = a.video_view > 0 ? round2(a.spend / a.video_view) : null;
    return { cpm: round2(a.cpm), reach: a.reach, video_views: a.video_view, cpv };
  }
  if (obj === 'OUTCOME_ENGAGEMENT')
    return { cpe: a.cpe !== null ? round2(a.cpe) : null, post_engagement: a.post_engagement };
  if (obj === 'OUTCOME_LEADS')
    return { cpl: a.cpl !== null ? round2(a.cpl) : null, lead: a.lead };
  if (obj === 'OUTCOME_APP_PROMOTION')
    return { cpi: a.cpi !== null ? round2(a.cpi) : null, app_install: a.app_install };
  return {};
}

/**
 * Classify adsets into scale/reduce/pause/refresh/maintain per objective.
 * Port of prepare-analysis.sh lines 224-398.
 *
 * Bug fix from shell: top_by_spend outputs ALL maintain adsets (removes [:5] truncation).
 */
export function computeBudgetActions(adsets: AdsetSummary[], config: IntelConfig): BudgetActions {
  const targets = config.targets ?? {};
  const globalMaxFreq = targets.global?.max_frequency ?? 5.0;
  const minSpend = targets.global?.min_spend ?? 0;
  const objectives = [...new Set(adsets.map((a) => a.objective))].sort();

  const result: BudgetActions = { objectives_present: objectives };

  for (const obj of objectives) {
    const objTargets = targets[obj] ?? {};
    const maxFreq = obj === 'OUTCOME_AWARENESS' ? (objTargets.max_frequency ?? globalMaxFreq) : globalMaxFreq;

    // Sort by descending spend
    const allObj = adsets.filter((a) => a.objective === obj).sort((a, b) => b.spend - a.spend);
    // M5 fallback: if min_spend filters out all, include all
    const filtered = allObj.filter((a) => a.spend >= minSpend);
    const working = filtered.length === 0 && allObj.length > 0 ? allObj : filtered;

    const classified: BudgetActionEntry[] = working.map((a) => {
      const { action, reason } = classifyAdset(a, obj, objTargets, maxFreq);
      return {
        adset_name: a.adset_name,
        campaign_name: a.campaign_name,
        objective: a.objective,
        action,
        reason,
        spend: a.spend,
        frequency: round2(a.frequency),
        ...objectiveFields(a, obj),
      } as BudgetActionEntry;
    });

    const scale = classified.filter((e) => e.action === 'scale');
    const reduce = classified.filter((e) => e.action === 'reduce');
    const pause = classified.filter((e) => e.action === 'pause');
    const refresh = classified.filter((e) => e.action === 'refresh');
    const maintain = classified.filter((e) => e.action === 'maintain');

    const group: BudgetActionGroup = {
      scale,
      reduce,
      pause,
      refresh,
      maintain: {
        count: maintain.length,
        top_by_spend: maintain, // All maintain adsets — bug fix from shell's [:5]
      },
      summary: {
        total_evaluated: classified.length,
        scale: scale.length,
        reduce: reduce.length,
        pause: pause.length,
        refresh: refresh.length,
        maintain: maintain.length,
      },
    };

    result[obj] = group;
  }

  return result;
}
