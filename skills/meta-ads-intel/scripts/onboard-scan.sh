#!/bin/bash
set -e

# Lightweight creative scan for onboarding.
# Pulls ad-level insights + creative text for the last 14 days.
# Returns top/bottom ads by ROAS and format breakdown.
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

# 4. Join insights with creative data + compute metrics
JOINED=$(echo "$INSIGHTS" | jq --argjson creatives "$CREATIVE_LOOKUP" '[
  (.data // .)[] |
  ((.ad_id // "") | tostring) as $aid |
  {
    ad_id: (.ad_id // null),
    ad_name: (.ad_name // null),
    campaign_name: (.campaign_name // null),
    spend: ((.spend // "0") | tonumber),
    purchases: ((.actions // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
    revenue: ((.action_values // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
    roas: ((.purchase_roas // []) | map(select(.action_type == "omni_purchase")) | .[0].value // "0" | tonumber),
    creative_body: (if $aid != "" then ($creatives[$aid].creative_body // "") else "" end),
    creative_title: (if $aid != "" then ($creatives[$aid].creative_title // "") else "" end),
    has_thumbnail: (if $aid != "" then (($creatives[$aid].creative_thumbnail_url // "") != "") else false end),
    has_image: (if $aid != "" then (($creatives[$aid].creative_image_url // "") != "") else false end)
  } |
  . + {
    cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
    format: (if .has_thumbnail then "video" elif .has_image then "image" else "unknown" end)
  }
]')

# 5. Compute output
echo "$JOINED" | jq '{
  # Cap slices so winners and losers never overlap
  ([sort_by(-.roas) | .[] | select(.purchases > 0)]) as $ranked |
  ($ranked | length) as $total |
  ([5, ($total / 2 | floor)] | min) as $win_n |
  ([5, ($total - $win_n)] | min | if . < 0 then 0 else . end) as $lose_n |
  winners: [$ranked[:$win_n][] | {ad_name, campaign_name, roas, cpa, creative_body, creative_title, format}],
  losers: [if $lose_n > 0 then $ranked[-$lose_n:][] else empty end | {ad_name, campaign_name, roas, cpa, creative_body, creative_title, format}],
  format_breakdown: {
    video: [.[] | select(.format == "video")] | length,
    image: [.[] | select(.format == "image")] | length,
    unknown: [.[] | select(.format == "unknown")] | length
  },
  total_ads: length,
  ads_with_purchases: [.[] | select(.purchases > 0)] | length
}'
