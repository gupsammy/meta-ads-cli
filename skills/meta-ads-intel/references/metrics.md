# Meta Ads Metrics Reference

## Actions Array

The `actions` field is an array of `{ action_type, value }` objects. Key types:

| action_type | Meaning | Use for |
|---|---|---|
| `purchase` | Pixel-tracked purchases | Primary conversion metric |
| `add_to_cart` | Add to cart events | Funnel midpoint |
| `initiate_checkout` | Checkout started | Funnel late stage |
| `view_content` | Product page views | Engagement metric (fires per product viewed, not per session — use browse_depth ratio) |
| `link_click` | Clicks to website | Traffic metric |
| `landing_page_view` | Page fully loaded after click | Actual site visitors |

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
- `link_click` and `landing_page_view` have no omni variants — use base names directly

Other duplicates (`web_in_store_purchase`, `onsite_web_purchase`, `onsite_web_app_purchase`, `offsite_conversion.fb_pixel_purchase`) are ignored — `omni_*` already deduplicates across these surfaces.

## Computed Metrics

- **CPA** = spend / purchase_count
- **ROAS** = purchase_revenue / spend (or from purchase_roas directly)
- **AOV** = purchase_revenue / purchase_count
- **Funnel rate** = next_stage_count / current_stage_count

## Currency

All monetary values are in the account's currency. Budget values from the API are in minor units (cents for USD, paisa for INR) — divide by 100 for display.
