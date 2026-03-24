// ─── API input types ───────────────────────────────────────────────

/** Single entry from Meta API actions / action_values / purchase_roas arrays */
export interface ActionEntry {
  action_type: string;
  value: string | number;
  /** Present on attribution-window duplicate rows — used by attrGuard to filter */
  action_attribution_window?: string;
  [key: string]: unknown;
}

/** Raw insights response row from the Meta Marketing API (loose shape) */
export interface InsightsRow {
  spend?: string;
  impressions?: string;
  clicks?: string;
  cpc?: string;
  ctr?: string;
  cpm?: string;
  frequency?: string;
  reach?: string;
  actions?: ActionEntry[];
  action_values?: ActionEntry[];
  purchase_roas?: ActionEntry[];
  [key: string]: unknown;
}

// ─── Metric extraction output types ────────────────────────────────

/** 21 numeric fields output by extractMetrics — never null */
export interface ExtractedMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  cpc: number;
  ctr: number;
  cpm: number;
  frequency: number;
  reach: number;
  purchases: number;
  revenue: number;
  roas: number;
  add_to_cart: number;
  initiate_checkout: number;
  view_content: number;
  link_clicks: number;
  landing_page_views: number;
  post_engagement: number;
  page_engagement: number;
  lead: number;
  app_install: number;
  video_view: number;
}

/** ExtractedMetrics + 6 nullable derived fields */
export interface DerivedMetrics extends ExtractedMetrics {
  cpa: number | null;
  cpe: number | null;
  cpl: number | null;
  cpi: number | null;
  link_click_ctr: number;
  link_click_cpc: number | null;
}

// ─── Summary types (output of summarize, input to prepare) ────────

export interface CampaignSummary extends DerivedMetrics {
  campaign_id: string | null;
  campaign_name: string | null;
  objective: string;
  date_start: string;
  date_stop: string;
}

export interface AdsetSummary extends DerivedMetrics {
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  objective: string;
  date_start: string;
  date_stop: string;
}

export interface AdSummary extends DerivedMetrics {
  ad_id: string | null;
  ad_name: string | null;
  adset_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  objective: string;
  date_start: string;
  date_stop: string;
  creative_body: string;
  creative_title: string;
}

// ─── Defaults types (output of compute-defaults) ─────────────────

/** Per-objective KPI block — shape varies by objective type */
export type ObjectiveDefaults = Record<string, number | null>;

/** Output of computeDefaults() — mirrors compute-defaults.sh JSON */
export interface DefaultsResult {
  objectives: Record<string, ObjectiveDefaults & { campaign_count: number; spend: number }>;
  total_spend: number;
  objectives_detected: string[];
}

// ─── Scan types (output of creative-scan) ─────────────────────────

/** Single ad entry in scan winners/losers lists */
export interface ScanAdEntry {
  ad_name: string | null;
  campaign_name: string | null;
  objective: string;
  roas: number;
  cpa: number | null;
  cpc: number;
  ctr: number;
  link_click_ctr: number;
  link_click_cpc: number | null;
  cpe: number | null;
  cpl: number | null;
  cpi: number | null;
  creative_body: string;
  creative_title: string;
  format: 'video' | 'image' | 'unknown';
}

/** Per-objective group in scan output */
export interface ScanObjectiveGroup {
  winners: ScanAdEntry[];
  losers: ScanAdEntry[];
  total_ads: number;
  ads_with_conversions: number;
}

/** Format breakdown across all scanned ads */
export interface FormatBreakdown {
  video: number;
  image: number;
  unknown: number;
  confidence: 'high' | 'low' | 'n/a';
}

/** Output of creativeScan() — mirrors onboard-scan.sh JSON */
export interface ScanResult {
  by_objective: Record<string, ScanObjectiveGroup>;
  format_breakdown: FormatBreakdown;
  objectives_detected: string[];
  total_ads: number;
}

// ─── Config types ──────────────────────────────────────────────────

export interface AnalysisConfig {
  top_n: number;
  bottom_n: number;
  zero_conversion_n: number;
}

/**
 * Config v2 schema — mirrors ~/.meta-ads-intel/config.json.
 * targets keys are objective strings (e.g. "OUTCOME_SALES") with loose
 * per-objective KPI thresholds (cpa, roas, cpc, ctr, etc.) plus a
 * "global" key for cross-objective settings (max_frequency, min_spend).
 * funnel_expected_rates is nested per-objective with stage-name keys.
 */
export interface IntelConfig {
  account_id: string;
  account_name: string;
  currency: string;
  config_version: number;
  objectives_detected: string[];
  primary_objective: string;
  targets: Record<string, Record<string, number>>;
  analysis: AnalysisConfig;
  funnel_expected_rates: Record<string, Record<string, number>>;
}

// ─── Analysis output types (output of prepare, read by agent) ─────
//
// These are placeholder types. The actual JSON shapes produced by
// prepare-analysis.sh are complex, per-objective, and vary by objective
// type. Precise interfaces will be defined when the prepare module is
// ported in a later PR. Using Record<string, unknown> avoids encoding
// incorrect contracts that downstream code might depend on.

/** account-health.json — per-objective health with vs_target percentages */
export type AccountHealth = Record<string, unknown>;

/** budget-actions.json — per-objective adset classifications */
export type BudgetActions = Record<string, unknown>;

/** funnel.json — per-objective funnel stages, rates, bottleneck */
export type FunnelData = Record<string, unknown>;

/** trends.json — prior vs recent deltas per campaign + flags */
export type TrendsData = Record<string, unknown>;

/** creative-analysis.json — per-objective winners/losers/zero-conversion */
export type CreativeAnalysis = Record<string, unknown>;

/** creative-media.json — ad_id + rank (string) + URLs for media extraction */
export type CreativeMedia = Record<string, unknown>;

/** pipeline-status.json — status, files_produced, files_skipped, warnings */
export type PipelineStatus = Record<string, unknown>;
