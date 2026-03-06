// Service layer — pure business logic, no CLI I/O concerns.
// Each function accepts a token + typed options, returns typed results.
// Errors propagate as HttpError or validation errors for the caller to handle.

export { listAccounts, getAccount, normalizeAccountId } from './accounts.js';
export { listCampaigns, getCampaign, createCampaign, updateCampaign, dryRunCreateCampaign, dryRunUpdateCampaign, buildCreateCampaignBody, buildUpdateCampaignBody } from './campaigns.js';
export { listAdSets, getAdSet, createAdSet, updateAdSet, dryRunCreateAdSet, dryRunUpdateAdSet, buildCreateAdSetBody, buildUpdateAdSetBody } from './adsets.js';
export { listAds, getAd, updateAd, dryRunUpdateAd, buildUpdateAdBody } from './ads.js';
export { getInsights, resolveInsightsPath, resolveInsightsLevel, InsightsValidationError } from './insights.js';
export { listAudiences, getAudience } from './audiences.js';

// Re-export all types
export type {
  PaginatedResult,
  AccountResult,
  ListAccountsOptions,
  CampaignListItem,
  CampaignDetail,
  ListCampaignsOptions,
  CreateCampaignOptions,
  CreateCampaignResult,
  UpdateCampaignOptions,
  UpdateResult,
  AdSetListItem,
  AdSetDetail,
  ListAdSetsOptions,
  CreateAdSetOptions,
  CreateAdSetResult,
  UpdateAdSetOptions,
  AdListItem,
  AdDetail,
  ListAdsOptions,
  UpdateAdOptions,
  InsightRow,
  GetInsightsOptions,
  AudienceListItem,
  AudienceDetail,
  ListAudiencesOptions,
  DryRunResult,
} from './types.js';
