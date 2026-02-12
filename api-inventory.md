# Meta Marketing API - API Inventory

## Base URL
`https://graph.facebook.com/v21.0`

## Authentication
- **Method:** OAuth2 access token
- **Token types:** User token, System User token, Page token
- **OAuth URL:** `https://www.facebook.com/v21.0/dialog/oauth`
- **Token exchange URL:** `https://graph.facebook.com/v21.0/oauth/access_token`
- **Required scopes:** `ads_management`, `ads_read`
- **Token passed as:** `access_token` query parameter or `Authorization: Bearer <token>` header

## Rate Limits
- Standard Marketing API: 200 calls per user per hour per ad account
- Batch API: Up to 50 requests per batch call
- Rate limit headers: `x-business-use-case-usage`, `x-app-usage`, `x-ad-account-usage`
- HTTP 429 returned when rate limited with `retry-after` header

## Pagination
- **Pattern:** Cursor-based pagination
- **Response structure:**
  ```json
  {
    "data": [...],
    "paging": {
      "cursors": { "before": "...", "after": "..." },
      "next": "https://graph.facebook.com/v21.0/...",
      "previous": "https://graph.facebook.com/v21.0/..."
    }
  }
  ```
- Use `after` cursor or follow `next` URL to paginate forward
- `limit` parameter controls page size (default varies by endpoint)

## Field Selection
All endpoints require explicit `fields` parameter to request specific data.
Example: `?fields=id,name,status`

## Resources

### Ad Accounts
- `GET /me/adaccounts` - List accessible ad accounts
- `GET /act_{account_id}` - Get account details
- **Fields:** id, name, account_id, account_status, currency, timezone_name, amount_spent, balance

### Campaigns
- `GET /act_{account_id}/campaigns` - List campaigns
- `GET /{campaign_id}` - Get campaign details
- `POST /act_{account_id}/campaigns` - Create campaign
- `POST /{campaign_id}` - Update campaign
- **Fields:** id, name, status, effective_status, objective, daily_budget, lifetime_budget, created_time, updated_time, start_time, stop_time
- **Objectives (v21):** OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_APP_PROMOTION, OUTCOME_SALES
- **Statuses:** ACTIVE, PAUSED, DELETED, ARCHIVED

### Ad Sets
- `GET /act_{account_id}/adsets` - List ad sets
- `GET /{adset_id}` - Get ad set details
- `POST /act_{account_id}/adsets` - Create ad set
- `POST /{adset_id}` - Update ad set
- **Fields:** id, name, status, effective_status, campaign_id, daily_budget, lifetime_budget, billing_event, optimization_goal, bid_amount, targeting, created_time, updated_time, start_time, end_time
- **Billing events:** IMPRESSIONS, LINK_CLICKS, APP_INSTALLS, PAGE_LIKES
- **Optimization goals:** REACH, IMPRESSIONS, LINK_CLICKS, LANDING_PAGE_VIEWS, LEAD_GENERATION, CONVERSIONS

### Ads
- `GET /act_{account_id}/ads` - List ads
- `GET /{ad_id}` - Get ad details
- `POST /{ad_id}` - Update ad
- **Fields:** id, name, status, effective_status, adset_id, campaign_id, creative{id}, created_time, updated_time

### Insights
- `GET /act_{account_id}/insights` - Account-level insights
- `GET /{campaign_id}/insights` - Campaign-level insights
- `GET /{adset_id}/insights` - Ad-set-level insights
- `GET /{ad_id}/insights` - Ad-level insights
- **Fields:** impressions, clicks, spend, cpc, cpm, ctr, reach, frequency, conversions, cost_per_conversion, date_start, date_stop
- **Date presets:** today, yesterday, this_month, last_month, last_7d, last_14d, last_28d, last_30d, last_90d, last_year
- **Custom range:** `time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}`
- **Breakdown levels:** account, campaign, adset, ad

### Custom Audiences
- `GET /act_{account_id}/customaudiences` - List custom audiences
- `GET /{audience_id}` - Get audience details
- **Fields:** id, name, description, subtype, approximate_count_lower_bound, approximate_count_upper_bound, time_created, time_updated, delivery_status
- **Subtypes:** CUSTOM, WEBSITE, APP, OFFLINE_CONVERSION, LOOKALIKE
