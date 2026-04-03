import type {
  AccountHealth,
  BudgetActions,
  BudgetActionGroup,
  FunnelData,
  FunnelObjective,
  TrendsData,
  CreativeAnalysis,
  CreativeObjectiveGroup,
  RecommendationsData,
  FatigueData,
  IntelConfig,
  Report,
  KpiSnapshot,
  BudgetSummary,
  BleederSummary,
  FunnelSummary,
  TrendAlert,
  CreativeHighlights,
  CrossRunDelta,
  DataReport,
  Bottleneck,
} from '../types.js';
import { round2 } from '../metrics.js';

function buildKpiSnapshot(health: AccountHealth | null): KpiSnapshot {
  if (!health) {
    return { total_spend: 0, total_impressions: 0, total_reach: 0, primary_objective: 'UNKNOWN', primary_kpis: {} };
  }
  const primary = health.primary_objective;
  const objData = health[primary] as Record<string, unknown> | undefined;
  const primaryKpis: Record<string, number | null> = {};
  if (objData) {
    for (const [k, v] of Object.entries(objData)) {
      if (typeof v === 'number' || v === null) {
        primaryKpis[k] = v === null ? null : typeof v === 'number' ? round2(v) : null;
      }
    }
  }
  return {
    total_spend: health.total_spend,
    total_impressions: health.total_impressions,
    total_reach: health.total_reach,
    primary_objective: primary,
    primary_kpis: primaryKpis,
  };
}

function buildBudgetSummary(actions: BudgetActions | null): BudgetSummary {
  const totals = { total_evaluated: 0, scale: 0, reduce: 0, pause: 0, refresh: 0, bleeders: 0, maintain: 0 };
  if (!actions) return totals;
  for (const key of Object.keys(actions)) {
    if (key === 'objectives_present') continue;
    const group = actions[key] as BudgetActionGroup;
    if (!group?.summary) continue;
    totals.total_evaluated += group.summary.total_evaluated;
    totals.scale += group.summary.scale;
    totals.reduce += group.summary.reduce;
    totals.pause += group.summary.pause;
    totals.refresh += group.summary.refresh;
    totals.bleeders += group.summary.bleeders;
    totals.maintain += group.summary.maintain;
  }
  return totals;
}

function buildBleederSummary(actions: BudgetActions | null): BleederSummary {
  const result: BleederSummary = { count: 0, total_spend: 0, entries: [] };
  if (!actions) return result;
  for (const key of Object.keys(actions)) {
    if (key === 'objectives_present') continue;
    const group = actions[key] as BudgetActionGroup;
    if (!group?.bleeders) continue;
    for (const b of group.bleeders) {
      result.count++;
      result.total_spend += b.spend;
      result.entries.push({ adset_name: b.adset_name, objective: b.objective, spend: b.spend, reason: b.reason });
    }
  }
  result.total_spend = round2(result.total_spend);
  return result;
}

function buildFunnelSummary(funnel: FunnelData | null): FunnelSummary {
  const result: FunnelSummary = { objectives_present: [], bottlenecks: [] };
  if (!funnel) return result;
  result.objectives_present = (funnel.objectives_present as string[]) ?? [];
  for (const key of Object.keys(funnel)) {
    if (key === 'objectives_present') continue;
    const obj = funnel[key] as FunnelObjective;
    if (!obj) continue;
    const bottleneck = (obj as Record<string, unknown>).bottleneck as Bottleneck | null | undefined;
    if (bottleneck) {
      result.bottlenecks.push({ objective: key, stage: bottleneck.stage, label: bottleneck.label, rate: bottleneck.rate });
    }
  }
  return result;
}

function buildTrendAlerts(trends: TrendsData | null): TrendAlert[] {
  if (!trends || !('available' in trends) || !trends.available) return [];
  return (trends.flagged ?? []).map((f) => ({
    campaign_name: f.campaign_name,
    objective: f.objective,
    flags: f.flags,
  }));
}

function buildCreativeHighlights(creative: CreativeAnalysis | null): CreativeHighlights {
  const result: CreativeHighlights = { objectives_present: [], top_winner: null, total_zero_conversion: 0, zero_conversion_spend: 0 };
  if (!creative) return result;
  result.objectives_present = (creative.objectives_present as string[]) ?? [];

  for (const key of Object.keys(creative)) {
    if (key === 'objectives_present' || key === 'cross_campaign_names') continue;
    const group = creative[key] as CreativeObjectiveGroup;
    if (!group?.overview) continue;
    result.total_zero_conversion += group.overview.zero_conversion_count;
    result.zero_conversion_spend += group.overview.zero_conversion_total_spend;

    if (group.winners?.length > 0 && !result.top_winner) {
      const w = group.winners[0];
      const metricName = key === 'OUTCOME_SALES' ? 'roas' : key === 'OUTCOME_TRAFFIC' ? 'ctr' : 'spend';
      const metricValue = (w as unknown as Record<string, unknown>)[metricName];
      result.top_winner = {
        ad_name: w.ad_name,
        objective: key,
        metric_name: metricName,
        metric_value: typeof metricValue === 'number' ? round2(metricValue) : 0,
      };
    }
  }
  result.zero_conversion_spend = round2(result.zero_conversion_spend);
  return result;
}

function synthesizeActionItems(
  bleeders: BleederSummary,
  alerts: TrendAlert[],
  funnelSummary: FunnelSummary,
  budgetSummary: BudgetSummary,
  currency: string,
): string[] {
  const items: string[] = [];

  if (bleeders.count > 0) {
    items.push(`Pause ${bleeders.count} bleeding adset${bleeders.count > 1 ? 's' : ''} wasting ${bleeders.total_spend} ${currency}`);
  }

  for (const alert of alerts) {
    const flagStr = alert.flags.join(', ');
    items.push(`Investigate ${alert.campaign_name ?? 'unknown campaign'}: ${flagStr}`);
  }

  for (const b of funnelSummary.bottlenecks) {
    items.push(`Fix ${b.objective} ${b.label} bottleneck: ${b.rate}%`);
  }

  if (budgetSummary.refresh > 0) {
    items.push(`${budgetSummary.refresh} adset${budgetSummary.refresh > 1 ? 's' : ''} need creative refresh (frequency > ceiling)`);
  }

  if (budgetSummary.scale > 0) {
    items.push(`${budgetSummary.scale} adset${budgetSummary.scale > 1 ? 's' : ''} ready to scale`);
  }

  return items;
}

/**
 * Build cross-run KPI deltas by comparing current health KPIs against a prior DataReport.
 * Returns null if no prior data is available.
 */
export function buildCrossRunDelta(
  currentKpis: Record<string, Record<string, number | null>>,
  currentFatigue: FatigueData | null,
  currentBudget: BudgetSummary,
  priorData: DataReport,
): CrossRunDelta {
  const kpiDeltas: CrossRunDelta['kpi_deltas'] = {};

  for (const [obj, currentFields] of Object.entries(currentKpis)) {
    const priorFields = priorData.primary_kpis[obj];
    if (!priorFields) continue;
    kpiDeltas[obj] = {};
    for (const [key, currentVal] of Object.entries(currentFields)) {
      const priorVal = priorFields[key] ?? null;
      let deltaPct: number | null = null;
      if (typeof currentVal === 'number' && typeof priorVal === 'number' && priorVal !== 0) {
        deltaPct = Math.round(((currentVal - priorVal) / Math.abs(priorVal)) * 100);
      }
      kpiDeltas[obj][key] = { prior: priorVal, current: currentVal, delta_pct: deltaPct };
    }
  }

  const fatigueDelta: CrossRunDelta['fatigue_delta'] = priorData.fatigue_summary && currentFatigue
    ? {
        prior: priorData.fatigue_summary,
        current: { rotate: currentFatigue.summary.rotate, watch: currentFatigue.summary.watch, healthy: currentFatigue.summary.healthy },
      }
    : null;

  const budgetDelta: CrossRunDelta['budget_delta'] = {
    prior: priorData.budget_actions_summary,
    current: currentBudget,
  };

  return {
    prior_date: priorData.date,
    prior_date_preset: priorData.date_preset,
    kpi_deltas: kpiDeltas,
    fatigue_delta: fatigueDelta,
    budget_delta: budgetDelta,
  };
}

/**
 * Build a DataReport from the computed analysis results for persistence to disk.
 * This enables cross-run comparisons on subsequent runs.
 */
export function buildDataReport(
  health: AccountHealth | null,
  budgetSummary: BudgetSummary,
  fatigue: FatigueData | null,
  creative: CreativeAnalysis | null,
  recommendations: RecommendationsData | null,
  datePreset: string,
  dateStr: string,
): DataReport {
  const primaryKpis: Record<string, Record<string, number | null>> = {};

  if (health) {
    for (const obj of health.objectives_present as string[]) {
      const objData = health[obj] as Record<string, unknown> | undefined;
      if (!objData) continue;
      const kpis: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(objData)) {
        // Exclude non-KPI fields from the data report
        if (['campaign_count', 'spend', 'spend_pct', 'impressions', 'reach'].includes(k)) continue;
        if (k.startsWith('target_') || k.endsWith('_vs_target')) continue;
        if (typeof v === 'number' || v === null) {
          kpis[k] = v;
        }
      }
      primaryKpis[obj] = kpis;
    }
  }

  let winnersCount = 0;
  let losersCount = 0;
  let zeroConvCount = 0;
  let zeroConvSpend = 0;

  if (creative) {
    for (const key of Object.keys(creative)) {
      if (key === 'objectives_present' || key === 'cross_campaign_names') continue;
      const group = creative[key] as { winners: unknown[]; losers: unknown[]; overview: { zero_conversion_count: number; zero_conversion_total_spend: number } } | undefined;
      if (!group) continue;
      winnersCount += group.winners.length;
      losersCount += group.losers.length;
      zeroConvCount += group.overview.zero_conversion_count;
      zeroConvSpend += group.overview.zero_conversion_total_spend;
    }
  }

  return {
    date: dateStr,
    date_preset: datePreset,
    primary_objective: health?.primary_objective ?? 'UNKNOWN',
    total_spend: health?.total_spend ?? 0,
    primary_kpis: primaryKpis,
    opportunity_score: recommendations?.opportunity_score ?? null,
    recommendations_count: recommendations?.data?.length ?? 0,
    budget_actions_summary: budgetSummary,
    fatigue_summary: fatigue ? { rotate: fatigue.summary.rotate, watch: fatigue.summary.watch, healthy: fatigue.summary.healthy } : null,
    creative_summary: {
      winners_count: winnersCount,
      losers_count: losersCount,
      zero_conv_count: zeroConvCount,
      zero_conv_spend: round2(zeroConvSpend),
    },
  };
}

export function computeReport(
  health: AccountHealth | null,
  actions: BudgetActions | null,
  funnel: FunnelData | null,
  trends: TrendsData | null,
  creative: CreativeAnalysis | null,
  _recommendations: RecommendationsData | null,
  config: IntelConfig,
  fatigue: FatigueData | null = null,
  priorData: DataReport | null = null,
): Report {
  const kpiSnapshot = buildKpiSnapshot(health);
  const budgetSummary = buildBudgetSummary(actions);
  const bleederSummary = buildBleederSummary(actions);
  const funnelSummary = buildFunnelSummary(funnel);
  const trendAlerts = buildTrendAlerts(trends);
  const creativeHighlights = buildCreativeHighlights(creative);
  const actionItems = synthesizeActionItems(bleederSummary, trendAlerts, funnelSummary, budgetSummary, config.currency);

  // Extract fatigue by_campaign from fatigue data
  const fatigueByCampaign = fatigue?.summary?.by_campaign ?? {};

  // Extract winner_stats per objective from creative analysis
  const creativeWinnerStats: Record<string, { total: number; empty_body: number; video: number; image_only: number }> = {};
  if (creative) {
    for (const key of Object.keys(creative)) {
      if (key === 'objectives_present' || key === 'cross_campaign_names') continue;
      const group = creative[key] as CreativeObjectiveGroup;
      if (group?.overview?.winner_stats) {
        creativeWinnerStats[key] = group.overview.winner_stats;
      }
    }
  }

  // Build cross-run delta if prior data is available
  let crossRunDelta: CrossRunDelta | null = null;
  if (priorData && health) {
    // Extract per-objective KPIs from health (same logic as buildDataReport)
    const currentKpis: Record<string, Record<string, number | null>> = {};
    for (const obj of health.objectives_present as string[]) {
      const objData = health[obj] as Record<string, unknown> | undefined;
      if (!objData) continue;
      const kpis: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(objData)) {
        if (['campaign_count', 'spend', 'spend_pct', 'impressions', 'reach'].includes(k)) continue;
        if (k.startsWith('target_') || k.endsWith('_vs_target')) continue;
        if (typeof v === 'number' || v === null) {
          kpis[k] = v;
        }
      }
      currentKpis[obj] = kpis;
    }
    crossRunDelta = buildCrossRunDelta(currentKpis, fatigue, budgetSummary, priorData);
  }

  return {
    generated_at: new Date().toISOString(),
    account_name: config.account_name,
    currency: config.currency,
    date_range: null, // filled by caller if period data available
    sections: {
      kpi_snapshot: kpiSnapshot,
      budget_summary: budgetSummary,
      bleeders: bleederSummary,
      funnel_health: funnelSummary,
      trend_alerts: trendAlerts,
      creative_highlights: creativeHighlights,
      fatigue_by_campaign: fatigueByCampaign,
      creative_winner_stats: creativeWinnerStats,
      cross_run_delta: crossRunDelta,
      action_items: actionItems,
    },
  };
}
