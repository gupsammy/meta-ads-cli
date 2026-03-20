#!/bin/bash
set -e

# Lightweight creative scan for onboarding.
# Pulls ad-level insights + creative text for the last 14 days.
# Returns top/bottom ads ranked by objective-appropriate metric + format breakdown.
#
# Usage: onboard-scan.sh <account_id>
# Requires: meta-ads CLI, jq

ACCOUNT_ID="${1:?Usage: onboard-scan.sh <account_id>}"
CLI="${META_ADS_CLI:-meta-ads}"

if ! command -v jq &>/dev/null; then
  echo '{"error": "jq is required but not installed"}' >&2
  exit 1
fi

# 1. Pull ad-level insights (last 14 days)
INSIGHTS=$("$CLI" insights get \
  --account-id "$ACCOUNT_ID" \
  --date-preset last_14d \
  --level ad \
  --limit 50 \
  -o json)

# 2. Pull ads with creative fields
ADS=$("$CLI" ads list \
  --account-id "$ACCOUNT_ID" \
  --limit 50 \
  -o json)

# 3. Build creative lookup: ad_id -> body, title, image_url, thumbnail_url
CREATIVE_LOOKUP=$(echo "$ADS" | jq 'INDEX((.data // .)[] ; .id) | map_values({
  creative_body: (.creative_body // ""),
  creative_title: (.creative_title // ""),
  creative_image_url: (.creative_image_url // ""),
  creative_thumbnail_url: (.creative_thumbnail_url // "")
})' 2>/dev/null || echo '{}')

# 4. Build objective lookup from campaigns-meta (if available, else pull)
CAMPAIGNS_META=$("$CLI" campaigns list --account-id "$ACCOUNT_ID" --limit 200 -o json 2>/dev/null || echo '{"data":[]}')
OBJ_LOOKUP=$(echo "$CAMPAIGNS_META" | jq 'INDEX((.data // .)[]; .id) | map_values(
  (.objective // "UNKNOWN") |
  if . == "LINK_CLICKS" then "OUTCOME_TRAFFIC"
  elif . == "CONVERSIONS" or . == "PRODUCT_CATALOG_SALES" or . == "OFFER_CLAIMS" then "OUTCOME_SALES"
  elif . == "BRAND_AWARENESS" or . == "REACH" or . == "LOCAL_AWARENESS" or . == "STORE_VISITS" or . == "VIDEO_VIEWS" then "OUTCOME_AWARENESS"
  elif . == "POST_ENGAGEMENT" or . == "PAGE_LIKES" or . == "EVENT_RESPONSES" or . == "MESSAGES" then "OUTCOME_ENGAGEMENT"
  elif . == "LEAD_GENERATION" then "OUTCOME_LEADS"
  elif . == "APP_INSTALLS" then "OUTCOME_APP_PROMOTION"
  else . end
)' 2>/dev/null || echo '{}')

# 5. Join insights with creative data + objective + compute metrics
JOINED=$(echo "$INSIGHTS" | jq --argjson creatives "$CREATIVE_LOOKUP" --argjson obj "$OBJ_LOOKUP" '[
  (.data // .)[] |
  ((.ad_id // "") | tostring) as $aid |
  ((.campaign_id // "") | tostring) as $cid |
  ((.actions // []) as $raw_a | ($raw_a | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_a else . end) as $actions |
  ((.action_values // []) as $raw_av | ($raw_av | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_av else . end) as $action_vals |
  {
    ad_id: (.ad_id // null),
    ad_name: (.ad_name // null),
    campaign_name: (.campaign_name // null),
    objective: ($obj[$cid] // "UNKNOWN"),
    spend: ((.spend // "0") | tonumber),
    impressions: ((.impressions // "0") | tonumber),
    cpc: ((.cpc // "0") | tonumber),
    ctr: ((.ctr // "0") | tonumber),
    cpm: ((.cpm // "0") | tonumber),
    link_clicks: ($actions | map(select(.action_type == "link_click")) | .[0].value // "0" | tonumber),
    purchases: ($actions | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    revenue: ($action_vals | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    roas: ((.purchase_roas // []) | map(select(has("action_attribution_window") | not)) | if length == 0 then ((.purchase_roas // [])) else . end | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    link_clicks: ($actions | map(select(.action_type == "link_click")) | .[0].value // "0" | tonumber),
    post_engagement: ($actions | map(select(.action_type == "post_engagement")) | .[0].value // "0" | tonumber),
    lead: ($actions | (map(select(.action_type == "onsite_conversion.lead_grouped")) + map(select(.action_type == "lead"))) | .[0].value // "0" | tonumber),
    app_install: ($actions | (map(select(.action_type == "omni_app_install")) + map(select(.action_type == "mobile_app_install")) + map(select(.action_type == "app_install"))) | .[0].value // "0" | tonumber),
    creative_body: (if $aid != "" then ($creatives[$aid].creative_body // "") else "" end),
    creative_title: (if $aid != "" then ($creatives[$aid].creative_title // "") else "" end),
    has_thumbnail: (if $aid != "" then (($creatives[$aid].creative_thumbnail_url // "") != "") else false end),
    has_image: (if $aid != "" then (($creatives[$aid].creative_image_url // "") != "") else false end)
  } |
  . + {
    cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
    cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
    cpl: (if .lead > 0 then (.spend / .lead) else null end),
    cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
    link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
    link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end),
    format: (if .has_thumbnail then "video" elif .has_image then "image" else "unknown" end)
  }
]')

# 6. Compute output — rank by objective-appropriate metric
echo "$JOINED" | jq '
  # Determine primary conversion per ad based on its objective
  map(. + {
    has_conversion: (
      if .objective == "OUTCOME_SALES" then (.purchases > 0)
      elif .objective == "OUTCOME_TRAFFIC" then (.link_clicks > 0)
      elif .objective == "OUTCOME_ENGAGEMENT" then (.post_engagement > 0)
      elif .objective == "OUTCOME_LEADS" then (.lead > 0)
      elif .objective == "OUTCOME_APP_PROMOTION" then (.app_install > 0)
      else (.spend > 0) end
    ),
    sort_metric: (
      if .objective == "OUTCOME_SALES" then .roas
      elif .objective == "OUTCOME_TRAFFIC" then .link_click_ctr
      elif .objective == "OUTCOME_ENGAGEMENT" then (if .cpe != null and .cpe > 0 then (1 / .cpe) else 0 end)
      elif .objective == "OUTCOME_LEADS" then (if .cpl != null and .cpl > 0 then (1 / .cpl) else 0 end)
      elif .objective == "OUTCOME_APP_PROMOTION" then (if .cpi != null and .cpi > 0 then (1 / .cpi) else 0 end)
      else .spend end
    )
  }) |

  # Group by objective and rank within each group
  ([.[].objective] | unique | sort) as $objectives |
  {
    by_objective: (
      [$objectives[] as $obj |
        [.[] | select(.objective == $obj)] |
        ([sort_by(-.sort_metric) | .[] | select(.has_conversion)]) as $ranked |
        ($ranked | length) as $total |
        ([5, ([1, ($total / 2 | floor)] | max)] | min) as $win_n |
        ([5, ($total - $win_n)] | min | if . < 0 then 0 else . end) as $lose_n |
        {($obj): {
          winners: [$ranked[:$win_n][] | {ad_name, campaign_name, objective, roas, cpa, cpc, ctr, link_click_ctr, link_click_cpc, cpe, cpl, cpi, creative_body, creative_title, format}],
          losers: [if $lose_n > 0 then $ranked[-$lose_n:][] else empty end | {ad_name, campaign_name, objective, roas, cpa, cpc, ctr, link_click_ctr, link_click_cpc, cpe, cpl, cpi, creative_body, creative_title, format}],
          total_ads: length,
          ads_with_conversions: ($ranked | length)
        }}
      ] | add // {}
    ),
    format_breakdown: {
      video: [.[] | select(.format == "video")] | length,
      image: [.[] | select(.format == "image")] | length,
      unknown: [.[] | select(.format == "unknown")] | length
    },
    objectives_detected: $objectives,
    total_ads: length
  }'
