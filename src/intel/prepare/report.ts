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
  IntelConfig,
  Report,
  KpiSnapshot,
  BudgetSummary,
  BleederSummary,
  FunnelSummary,
  TrendAlert,
  CreativeHighlights,
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
    if (key === 'objectives_present') continue;
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
): string[] {
  const items: string[] = [];

  if (bleeders.count > 0) {
    items.push(`Pause ${bleeders.count} bleeding adset${bleeders.count > 1 ? 's' : ''} wasting ${bleeders.total_spend}`);
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

export function computeReport(
  health: AccountHealth | null,
  actions: BudgetActions | null,
  funnel: FunnelData | null,
  trends: TrendsData | null,
  creative: CreativeAnalysis | null,
  _recommendations: RecommendationsData | null,
  config: IntelConfig,
): Report {
  const kpiSnapshot = buildKpiSnapshot(health);
  const budgetSummary = buildBudgetSummary(actions);
  const bleederSummary = buildBleederSummary(actions);
  const funnelSummary = buildFunnelSummary(funnel);
  const trendAlerts = buildTrendAlerts(trends);
  const creativeHighlights = buildCreativeHighlights(creative);
  const actionItems = synthesizeActionItems(bleederSummary, trendAlerts, funnelSummary, budgetSummary);

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
      action_items: actionItems,
    },
  };
}
