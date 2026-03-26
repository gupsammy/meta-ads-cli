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
  /** Legacy key — shell falls back to this when zero_conversion_n is absent */
  zero_purchase_n?: number;
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

/** Per-objective KPI block in account-health.json — shape varies by objective */
export interface AccountHealthObjective {
  campaign_count: number;
  spend: number;
  impressions: number;
  reach: number;
  [key: string]: number | string | null;
}

/** account-health.json — per-objective health with vs_target percentages */
export interface AccountHealth {
  account_name: string;
  currency: string;
  primary_objective: string;
  objectives_present: string[];
  total_spend: number;
  total_impressions: number;
  total_reach: number;
  [key: string]: AccountHealthObjective | string | string[] | number;
}

/** Per-adset classification entry in budget-actions.json */
export interface BudgetActionEntry {
  adset_name: string | null;
  campaign_name: string | null;
  objective: string;
  action: 'scale' | 'reduce' | 'pause' | 'refresh' | 'maintain';
  reason: string;
  spend: number;
  frequency: number;
  [key: string]: string | number | null;
}

/** Per-objective budget action group */
export interface BudgetActionGroup {
  scale: BudgetActionEntry[];
  reduce: BudgetActionEntry[];
  pause: BudgetActionEntry[];
  refresh: BudgetActionEntry[];
  maintain: { count: number; top_by_spend: BudgetActionEntry[] };
  summary: {
    total_evaluated: number;
    scale: number;
    reduce: number;
    pause: number;
    refresh: number;
    maintain: number;
  };
}

/** budget-actions.json — per-objective adset classifications */
export interface BudgetActions {
  objectives_present: string[];
  [key: string]: BudgetActionGroup | string[];
}

/** Bottleneck detection result */
export interface Bottleneck {
  stage: string;
  label: string;
  rate: number;
}

/** Per-objective funnel data — varies by objective type */
export interface FunnelObjective {
  type: 'funnel' | 'reach_efficiency' | 'unknown';
  [key: string]: unknown;
}

/** funnel.json — per-objective funnel stages, rates, bottleneck */
export interface FunnelData {
  objectives_present: string[];
  [key: string]: FunnelObjective | string[];
}

/** Per-campaign trend entry */
export interface TrendCampaign {
  campaign_name: string | null;
  campaign_id: string | null;
  objective: string;
  prior_spend: number;
  recent_spend: number;
  period_frequency: number;
  recent_frequency: number | null;
  flags: string[];
  [key: string]: string | number | string[] | null;
}

/** Flagged campaign summary */
export interface TrendFlagged {
  campaign_name: string | null;
  objective: string;
  flags: string[];
}

/** Recently inactive campaign */
export interface TrendInactive {
  campaign_name: string | null;
  campaign_id: string | null;
  objective: string;
  period_spend: number;
}

/** trends.json — prior vs recent deltas per campaign + flags */
export type TrendsData =
  | { available: false; reason: string }
  | {
      available: true;
      period: { start: string | null; stop: string | null };
      recent: { start: string | null; stop: string | null };
      objectives_present: string[];
      campaigns: TrendCampaign[];
      flagged: TrendFlagged[];
      recently_inactive: TrendInactive[];
    };

/** Formatted ad entry in creative-analysis winners/losers */
export interface CreativeAdEntry {
  ad_name: string | null;
  campaign_name: string | null;
  creative_body: string;
  creative_title: string;
  spend: number;
  roas: number;
  cpa: number | null;
  cpc: number;
  ctr: number;
  cpe: number | null;
  cpl: number | null;
  cpi: number | null;
  impressions: number;
  cpm: number | null;
  reach: number;
  video_views: number;
  purchases: number;
  post_engagement: number;
  lead: number;
  app_install: number;
}

/** Zero-conversion ad entry */
export interface CreativeZeroEntry {
  ad_name: string | null;
  campaign_name: string | null;
  creative_body: string;
  creative_title: string;
  spend: number;
  impressions: number;
  cpm: number | null;
  reach: number;
  video_views: number;
}

/** Per-objective creative analysis group */
export interface CreativeObjectiveGroup {
  overview: {
    total_ads: number;
    with_conversions: number;
    zero_conversion_count: number;
    zero_conversion_total_spend: number;
  };
  winners: CreativeAdEntry[];
  losers: CreativeAdEntry[];
  zero_conversion: CreativeZeroEntry[];
}

/** creative-analysis.json — per-objective winners/losers/zero-conversion */
export interface CreativeAnalysis {
  objectives_present: string[];
  [key: string]: CreativeObjectiveGroup | string[];
}

/** creative-media.json — flat array entry with ad_id + rank + URLs */
export interface CreativeMediaEntry {
  ad_id: string | null;
  ad_name: string | null;
  objective: string;
  rank: 'winner' | 'loser' | 'zero_conversion';
  primary_metric_name: string;
  primary_metric_value: number;
  spend: number;
  creative_image_url: string;
  creative_thumbnail_url: string;
}

/** creative-media.json is a flat array */
export type CreativeMedia = CreativeMediaEntry[];

// ─── Pull types (raw API response shapes) ─────────────────────────

/** Raw campaign row from /{accountId}/campaigns (metadata, not insights) */
export interface CampaignMetaRow {
  id: string;
  objective?: string;
}

/** Raw ad row from /{accountId}/ads with nested creative fields */
export interface AdCreativeRow {
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

/** pipeline-status.json — status, files_produced, files_skipped, warnings */
export interface PipelineStatus {
  status: 'complete' | 'partial';
  files_produced: string[];
  files_skipped: string[];
  warnings: string[];
}

// ─── Creative artifact types (analyze-creatives output) ─────────

export type Orientation = 'landscape' | 'portrait' | 'square';

export interface VideoMetadata {
  type: 'video';
  duration: number;
  width: number | null;
  height: number | null;
  aspect_ratio: string;
  codec: string;
  orientation: Orientation;
}

export interface ImageMetadata {
  type: 'image';
  width: number;
  height: number;
  orientation: Orientation;
}

export interface ErrorMetadata {
  type?: string;
  error: string;
  message?: string;
  fallback?: string;
}

export interface CreativeManifestEntry {
  ad_id: string;
  ad_name: string;
  rank: string;
  roas: number;
  cpa: number;
  media_type: string;
  duration: number | null;
  orientation: string;
  frames: string[];
  frame_count: number;
  artifacts_dir: string;
}

export interface AnalyzeCreativesOptions {
  inputFile: string;
  dataDir?: string;
  accessToken?: string;
}

export interface AnalyzeCreativesResult {
  creatives_dir: string;
  total_ads: number;
  total_frames: number;
  manifest: CreativeManifestEntry[];
  warnings: string[];
}

// ─── Run types (intel run orchestrator) ─────────────────────────

export interface RunResult {
  runDir: string;
  pipelineStatus: PipelineStatus;
  warnings: string[];
  creatives?: AnalyzeCreativesResult;
}
