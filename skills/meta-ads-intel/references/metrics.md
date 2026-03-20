# Meta Ads Metrics Reference

## Actions Array

The `actions` field is an array of `{ action_type, value }` objects. Key types:

| action_type | Meaning | Use for |
|---|---|---|
| `purchase` | Pixel-tracked purchases | Primary conversion metric (Sales) |
| `add_to_cart` | Add to cart events | Funnel midpoint (Sales) |
| `initiate_checkout` | Checkout started | Funnel late stage (Sales) |
| `view_content` | Product page views | Engagement metric (fires per product viewed, not per session — use browse_depth ratio) |
| `link_click` | Clicks to website | Traffic metric, funnel top (Traffic/Leads/App) |
| `landing_page_view` | Page fully loaded after click | Actual site visitors |
| `post_engagement` | All post interactions (likes, comments, shares, clicks) | Primary conversion metric (Engagement) |
| `page_engagement` | Page-level interactions (page likes, check-ins) | Deep engagement metric (Engagement) |
| `lead` | Lead form submissions (fallback for onsite_conversion.lead_grouped) | Primary conversion metric (Leads) |
| `onsite_conversion.lead_grouped` | On-platform lead events (preferred over `lead`) | Primary conversion metric (Leads) |
| `mobile_app_install` | App installs tracked via SDK | Primary conversion metric (App Promotion) |
| `app_install` | App installs (fallback) | Primary conversion metric (App Promotion) |
| `video_view` | 3-second video views | Engagement signal for video ads |

## Action Values Array

Same structure as `actions`. The `value` field is revenue in account currency. Use `action_type: "purchase"` for purchase revenue.

## Purchase ROAS

The `purchase_roas` array contains `action_type: "omni_purchase"` — cross-surface deduplicated ROAS. Most reliable ROAS number. Use directly instead of computing spend/revenue.

## Duplicate Action Types

Meta reports the same event through multiple attribution surfaces. The skill prefers `omni_*` variants (cross-surface deduplicated) with fallback to base names:
- `omni_purchase` preferred over `purchase` — identical for online-only stores, more accurate for multi-channel
- `omni_add_to_cart` preferred over `add_to_cart`
- `omni_initiated_checkout` preferred over `initiate_checkout` (note: omni uses past tense)
- `omni_view_content` preferred over `view_content`
- `omni_app_install` preferred over `mobile_app_install` preferred over `app_install`
- `onsite_conversion.lead_grouped` preferred over `lead`
- `link_click` and `landing_page_view` have no omni variants — use base names directly
- `post_engagement` and `page_engagement` have no omni variants — use base names directly

Other duplicates (`web_in_store_purchase`, `onsite_web_purchase`, `onsite_web_app_purchase`, `offsite_conversion.fb_pixel_purchase`) are ignored — `omni_*` already deduplicates across these surfaces.

## Computed Metrics

### Sales (OUTCOME_SALES)
- **CPA** = spend / purchase_count
- **ROAS** = purchase_revenue / spend (or from purchase_roas directly)
- **AOV** = purchase_revenue / purchase_count
- **Funnel rate** = next_stage_count / current_stage_count

### Traffic (OUTCOME_TRAFFIC)
- **CPC** = spend / link_clicks (also available as top-level API field)
- **CTR** = link_clicks / impressions * 100 (also available as top-level API field)
- **Landing rate** = landing_page_views / link_clicks * 100

### Awareness (OUTCOME_AWARENESS)
- **CPM** = spend / impressions * 1000 (also available as top-level API field)
- **Reach rate** = reach / impressions * 100
- **Frequency** = impressions / reach (available as top-level API field)

### Engagement (OUTCOME_ENGAGEMENT)
- **CPE** = spend / post_engagement
- **Engagement rate** = post_engagement / impressions * 100
- **Deep engagement rate** = page_engagement / post_engagement * 100

### Leads (OUTCOME_LEADS)
- **CPL** = spend / lead_count
- **Lead conversion rate** = leads / landing_page_views * 100

### App Promotion (OUTCOME_APP_PROMOTION)
- **CPI** = spend / app_installs
- **Install rate** = app_installs / link_clicks * 100

## Currency

All monetary values are in the account's currency. Budget values from the API are in minor units (cents for USD, paisa for INR) — divide by 100 for display.
