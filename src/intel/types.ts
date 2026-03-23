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
  campaign_id: string;
  campaign_name: string;
  objective: string;
  date_start: string;
  date_stop: string;
}

export interface AdsetSummary extends DerivedMetrics {
  adset_id: string;
  adset_name: string;
  campaign_id: string;
  campaign_name: string;
  objective: string;
  date_start: string;
  date_stop: string;
}

export interface AdSummary extends DerivedMetrics {
  ad_id: string;
  ad_name: string;
  adset_id: string;
  campaign_id: string;
  campaign_name: string;
  objective: string;
  date_start: string;
  date_stop: string;
  creative_body: string;
  creative_title: string;
}

// ─── Config types ──────────────────────────────────────────────────

export interface ObjectiveTargets {
  target_roas?: number;
  target_cpa?: number;
  target_cpl?: number;
  target_cpi?: number;
  target_cpe?: number;
  target_cpm?: number;
}

export interface AnalysisConfig {
  top_n: number;
  bottom_n: number;
  zero_conversion_n: number;
}

export interface IntelConfig {
  account_id: string;
  account_name: string;
  currency: string;
  config_version: number;
  objectives_detected: string[];
  primary_objective: string;
  targets: Record<string, ObjectiveTargets>;
  analysis: AnalysisConfig;
  funnel_expected_rates: Record<string, number>;
}

// ─── Analysis output types (output of prepare, read by agent) ─────

export interface ObjectiveHealth {
  objective: string;
  vs_target: Record<string, number>;
}

export interface AccountHealth {
  objectives: ObjectiveHealth[];
}

export interface AdsetAction {
  adset_id: string;
  adset_name: string;
  campaign_id: string;
  action: 'scale' | 'maintain' | 'reduce' | 'pause' | 'refresh';
  reason: string;
}

export interface BudgetActions {
  by_objective: Record<string, AdsetAction[]>;
}

export interface FunnelStage {
  stage: string;
  value: number;
  rate: number;
}

export interface ObjectiveFunnel {
  stages: FunnelStage[];
  bottleneck: string | null;
}

export interface FunnelData {
  by_objective: Record<string, ObjectiveFunnel>;
}

export interface CampaignTrend {
  campaign_id: string;
  campaign_name: string;
  prior: Record<string, number>;
  recent: Record<string, number>;
  deltas: Record<string, number>;
  flags: string[];
}

export interface TrendsData {
  campaigns: CampaignTrend[];
}

export interface CreativeEntry {
  ad_id: string;
  ad_name: string;
  rank: number;
  metrics: Partial<DerivedMetrics>;
}

export interface ObjectiveCreatives {
  winners: CreativeEntry[];
  losers: CreativeEntry[];
  zero_conversion: CreativeEntry[];
}

export interface CreativeAnalysis {
  by_objective: Record<string, ObjectiveCreatives>;
}

export interface CreativeMedia {
  ad_id: string;
  rank: number;
  image_url?: string;
  thumbnail_url?: string;
}

export interface PipelineStatus {
  status: 'success' | 'partial' | 'error';
  files_produced: string[];
  files_skipped: string[];
  warnings: string[];
}
