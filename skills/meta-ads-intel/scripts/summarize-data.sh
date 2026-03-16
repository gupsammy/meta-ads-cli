#!/bin/bash
set -e

# Summarize raw Meta Ads JSON into compact agent-readable summaries.
# Extracts only the fields the agent needs from verbose actions arrays.
# Reduces file size by ~85-92%.
#
# Usage: summarize-data.sh <directory>
#   where <directory> contains campaigns.json, adsets.json, ads.json, creatives.json

DIR="$1"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "Usage: summarize-data.sh <directory>" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed." >&2
  exit 1
fi

# Summarize campaigns
if [[ -f "$DIR/campaigns.json" ]]; then
  jq '[(.data // .)[] | {
    campaign_id: (.campaign_id // null),
    campaign_name: (.campaign_name // null),
    date_start,
    date_stop,
    spend: ((.spend // "0") | tonumber),
    impressions: ((.impressions // "0") | tonumber),
    clicks: ((.clicks // "0") | tonumber),
    cpc: ((.cpc // "0") | tonumber),
    ctr: ((.ctr // "0") | tonumber),
    cpm: ((.cpm // "0") | tonumber),
    frequency: ((.frequency // "0") | tonumber),
    reach: ((.reach // "0") | tonumber),
    purchases: ((.actions // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
    revenue: ((.action_values // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
    roas: ((.purchase_roas // []) | map(select(.action_type == "omni_purchase")) | .[0].value // "0" | tonumber),
    add_to_cart: ((.actions // []) | map(select(.action_type == "add_to_cart")) | .[0].value // "0" | tonumber),
    initiate_checkout: ((.actions // []) | map(select(.action_type == "initiate_checkout")) | .[0].value // "0" | tonumber),
    view_content: ((.actions // []) | map(select(.action_type == "view_content")) | .[0].value // "0" | tonumber),
    link_clicks: ((.actions // []) | map(select(.action_type == "link_click")) | .[0].value // "0" | tonumber),
    landing_page_views: ((.actions // []) | map(select(.action_type == "landing_page_view")) | .[0].value // "0" | tonumber)
  } | . + {cpa: (if .purchases > 0 then (.spend / .purchases) else null end)}]' \
    "$DIR/campaigns.json" > "$DIR/campaigns-summary.json"
  echo "  campaigns-summary.json: $(wc -l < "$DIR/campaigns-summary.json" | tr -d ' ') lines"
fi

# Summarize adsets
if [[ -f "$DIR/adsets.json" ]]; then
  jq '[(.data // .)[] | {
    adset_id: (.adset_id // null),
    adset_name: (.adset_name // null),
    campaign_id: (.campaign_id // null),
    campaign_name: (.campaign_name // null),
    date_start,
    date_stop,
    spend: ((.spend // "0") | tonumber),
    impressions: ((.impressions // "0") | tonumber),
    clicks: ((.clicks // "0") | tonumber),
    cpc: ((.cpc // "0") | tonumber),
    ctr: ((.ctr // "0") | tonumber),
    cpm: ((.cpm // "0") | tonumber),
    frequency: ((.frequency // "0") | tonumber),
    reach: ((.reach // "0") | tonumber),
    purchases: ((.actions // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
    revenue: ((.action_values // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
    roas: ((.purchase_roas // []) | map(select(.action_type == "omni_purchase")) | .[0].value // "0" | tonumber),
    add_to_cart: ((.actions // []) | map(select(.action_type == "add_to_cart")) | .[0].value // "0" | tonumber),
    initiate_checkout: ((.actions // []) | map(select(.action_type == "initiate_checkout")) | .[0].value // "0" | tonumber),
    view_content: ((.actions // []) | map(select(.action_type == "view_content")) | .[0].value // "0" | tonumber)
  } | . + {cpa: (if .purchases > 0 then (.spend / .purchases) else null end)}]' \
    "$DIR/adsets.json" > "$DIR/adsets-summary.json"
  echo "  adsets-summary.json: $(wc -l < "$DIR/adsets-summary.json" | tr -d ' ') lines"
fi

# Summarize ads — join with creative content from creatives.json
if [[ -f "$DIR/ads.json" ]]; then
  if [[ -f "$DIR/creatives.json" ]]; then
    # Build creative lookup: ad_id -> creative fields
    jq 'INDEX((.data // .)[] ; .id) | map_values({
      creative_body: .creative_body,
      creative_title: .creative_title,
      creative_image_url: .creative_image_url,
      creative_thumbnail_url: .creative_thumbnail_url
    })' "$DIR/creatives.json" > "$DIR/_creative_lookup.json" 2>/dev/null || echo '{}' > "$DIR/_creative_lookup.json"

    jq --slurpfile creatives "$DIR/_creative_lookup.json" '[(.data // .)[] |
      ((.ad_id // "") | tostring) as $aid |
      {
        ad_id: (.ad_id // null),
        ad_name: (.ad_name // null),
        adset_id: (.adset_id // null),
        campaign_id: (.campaign_id // null),
        campaign_name: (.campaign_name // null),
        date_start,
        date_stop,
        spend: ((.spend // "0") | tonumber),
        impressions: ((.impressions // "0") | tonumber),
        clicks: ((.clicks // "0") | tonumber),
        cpc: ((.cpc // "0") | tonumber),
        ctr: ((.ctr // "0") | tonumber),
        frequency: ((.frequency // "0") | tonumber),
        reach: ((.reach // "0") | tonumber),
        purchases: ((.actions // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
        revenue: ((.action_values // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
        roas: ((.purchase_roas // []) | map(select(.action_type == "omni_purchase")) | .[0].value // "0" | tonumber),
        creative_body: (if $aid != "" then ($creatives[0][$aid].creative_body // "") else "" end),
        creative_title: (if $aid != "" then ($creatives[0][$aid].creative_title // "") else "" end),
        creative_image_url: (if $aid != "" then ($creatives[0][$aid].creative_image_url // "") else "" end),
        creative_thumbnail_url: (if $aid != "" then ($creatives[0][$aid].creative_thumbnail_url // "") else "" end)
      } | . + {cpa: (if .purchases > 0 then (.spend / .purchases) else null end)}]' \
      "$DIR/ads.json" > "$DIR/ads-summary.json"

    rm -f "$DIR/_creative_lookup.json"
  else
    jq '[(.data // .)[] | {
      ad_id: (.ad_id // null),
      ad_name: (.ad_name // null),
      adset_id: (.adset_id // null),
      campaign_id: (.campaign_id // null),
      campaign_name: (.campaign_name // null),
      date_start,
      date_stop,
      spend: ((.spend // "0") | tonumber),
      impressions: ((.impressions // "0") | tonumber),
      clicks: ((.clicks // "0") | tonumber),
      cpc: ((.cpc // "0") | tonumber),
      ctr: ((.ctr // "0") | tonumber),
      frequency: ((.frequency // "0") | tonumber),
      reach: ((.reach // "0") | tonumber),
      purchases: ((.actions // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
      revenue: ((.action_values // []) | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
      roas: ((.purchase_roas // []) | map(select(.action_type == "omni_purchase")) | .[0].value // "0" | tonumber)
    } | . + {cpa: (if .purchases > 0 then (.spend / .purchases) else null end)}]' \
      "$DIR/ads.json" > "$DIR/ads-summary.json"
  fi
  echo "  ads-summary.json: $(wc -l < "$DIR/ads-summary.json" | tr -d ' ') lines"
fi

echo "  Summarization complete for $(basename "$DIR")"
