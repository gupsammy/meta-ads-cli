// Re-export for convenience
export type { PaginatedResult } from '../lib/http.js';

// --- Accounts ---

export interface AccountResult {
  id: string;
  name: string;
  account_id: string;
  status: string;
  currency: string;
  timezone: string;
  amount_spent: string;
}

export interface ListAccountsOptions {
  limit?: number;
  after?: string;
}

// --- Campaigns ---

export interface CampaignListItem {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  objective: string;
  daily_budget: string;
  lifetime_budget: string;
  created_time: string;
}

export interface CampaignDetail extends CampaignListItem {
  updated_time: string;
  start_time: string;
  stop_time: string;
}

export interface ListCampaignsOptions {
  accountId: string;
  status?: string;
  limit?: number;
  after?: string;
}

export interface CreateCampaignOptions {
  accountId: string;
  name: string;
  objective: string;
  status?: string;
  dailyBudget?: string;
  lifetimeBudget?: string;
  specialAdCategories?: string;
}

export interface CreateCampaignResult {
  id: string;
  name: string;
  status: string;
  objective: string;
}

export interface UpdateCampaignOptions {
  campaignId: string;
  name?: string;
  status?: string;
  dailyBudget?: string;
  lifetimeBudget?: string;
}

export interface UpdateResult {
  id: string;
  updated: boolean;
  changes: Record<string, unknown>;
}

// --- Ad Sets ---

export interface AdSetListItem {
  id: string;
  name: string;
  campaign_id: string;
  status: string;
  effective_status: string;
  billing_event: string;
  optimization_goal: string;
  daily_budget: string;
  created_time: string;
}

export interface AdSetDetail extends AdSetListItem {
  lifetime_budget: string;
  bid_amount: string;
  targeting: string;
  updated_time: string;
  start_time: string;
  end_time: string;
}

export interface ListAdSetsOptions {
  accountId: string;
  campaignId?: string;
  status?: string;
  limit?: number;
  after?: string;
}

export interface CreateAdSetOptions {
  accountId: string;
  campaignId: string;
  name: string;
  billingEvent: string;
  optimizationGoal: string;
  dailyBudget?: string;
  lifetimeBudget?: string;
  bidAmount?: string;
  targeting?: Record<string, unknown>;
  startTime?: string;
  endTime?: string;
  status?: string;
}

export interface CreateAdSetResult {
  id: string;
  name: string;
  campaign_id: string;
  status: string;
}

export interface UpdateAdSetOptions {
  adsetId: string;
  name?: string;
  status?: string;
  dailyBudget?: string;
  lifetimeBudget?: string;
  bidAmount?: string;
  targeting?: Record<string, unknown>;
}

// --- Ads ---

export interface AdListItem {
  id: string;
  name: string;
  adset_id: string;
  campaign_id: string;
  status: string;
  effective_status: string;
  creative_id: string;
  creative_title: string;
  creative_body: string;
  creative_image_url: string;
  creative_thumbnail_url: string;
  created_time: string;
}

export interface AdDetail extends AdListItem {
  updated_time: string;
}

export interface ListAdsOptions {
  accountId: string;
  adsetId?: string;
  campaignId?: string;
  status?: string;
  limit?: number;
  after?: string;
}

export interface UpdateAdOptions {
  adId: string;
  name?: string;
  status?: string;
}

// --- Insights ---

export type InsightRow = Record<string, unknown>;

export interface GetInsightsOptions {
  accountId?: string;
  campaignId?: string;
  adsetId?: string;
  adId?: string;
  datePreset?: string;
  since?: string;
  until?: string;
  level?: string;
  fields?: string;
  timeIncrement?: string;
  limit?: string;
}

// --- Audiences ---

export interface AudienceListItem {
  id: string;
  name: string;
  description: string;
  subtype: string;
  approx_count_lower: number | string;
  approx_count_upper: number | string;
  delivery_status: string;
  time_created: string;
}

export interface AudienceDetail extends AudienceListItem {
  time_updated: string;
}

export interface ListAudiencesOptions {
  accountId: string;
  limit?: number;
  after?: string;
}

// --- Dry run ---

export interface DryRunResult {
  dry_run: true;
  method: string;
  path: string;
  body: Record<string, unknown>;
}
