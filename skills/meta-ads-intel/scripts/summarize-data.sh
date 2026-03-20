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

# Build objective lookup from campaigns-meta.json (campaigns list endpoint).
# Maps campaign id -> objective. Insights use campaign_id, campaigns list uses id.
OBJ_LOOKUP="$DIR/_objective_lookup.json"
if [[ -f "$DIR/campaigns-meta.json" ]]; then
  if ! jq 'INDEX((.data // .)[]; .id) | map_values(.objective // "UNKNOWN")' \
       "$DIR/campaigns-meta.json" > "$OBJ_LOOKUP" 2>/dev/null; then
    echo "Warning: campaigns-meta.json parse failed — objective filtering disabled" >&2
    echo '{}' > "$OBJ_LOOKUP"
  fi
else
  echo '{}' > "$OBJ_LOOKUP"
fi

# Normalize legacy objectives to OUTCOME_* equivalents
if [[ -f "$OBJ_LOOKUP" && -s "$OBJ_LOOKUP" ]]; then
  jq 'map_values(
    if . == "LINK_CLICKS" then "OUTCOME_TRAFFIC"
    elif . == "CONVERSIONS" or . == "PRODUCT_CATALOG_SALES" or . == "OFFER_CLAIMS" then "OUTCOME_SALES"
    elif . == "BRAND_AWARENESS" or . == "REACH" or . == "LOCAL_AWARENESS" or . == "STORE_VISITS" then "OUTCOME_AWARENESS"
    elif . == "POST_ENGAGEMENT" or . == "PAGE_LIKES" or . == "VIDEO_VIEWS" or . == "EVENT_RESPONSES" or . == "MESSAGES" then "OUTCOME_ENGAGEMENT"
    elif . == "LEAD_GENERATION" then "OUTCOME_LEADS"
    elif . == "APP_INSTALLS" then "OUTCOME_APP_PROMOTION"
    else . end
  )' "$OBJ_LOOKUP" > "${OBJ_LOOKUP}.tmp" && mv "${OBJ_LOOKUP}.tmp" "$OBJ_LOOKUP"
fi

# Summarize campaigns
if [[ -f "$DIR/campaigns.json" ]]; then
  jq --slurpfile obj "$OBJ_LOOKUP" '[(.data // .)[] |
    # Attribution guard — filter out windowed duplicates, fall back to raw if all filtered
    ((.actions // []) as $raw_a | ($raw_a | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_a else . end) as $actions |
    ((.action_values // []) as $raw_av | ($raw_av | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_av else . end) as $action_vals |
    {
    campaign_id: (.campaign_id // null),
    campaign_name: (.campaign_name // null),
    objective: ((.campaign_id // "") | tostring | . as $cid | ($obj[0][$cid] // "UNKNOWN")),
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
    # Sales
    purchases: ($actions | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    revenue: ($action_vals | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    roas: ((.purchase_roas // []) | map(select(has("action_attribution_window") | not)) | if length == 0 then ((.purchase_roas // [])) else . end | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    # Funnel
    add_to_cart: ($actions | (map(select(.action_type == "omni_add_to_cart")) + map(select(.action_type == "add_to_cart"))) | .[0].value // "0" | tonumber),
    initiate_checkout: ($actions | (map(select(.action_type == "omni_initiated_checkout")) + map(select(.action_type == "initiate_checkout"))) | .[0].value // "0" | tonumber),
    view_content: ($actions | (map(select(.action_type == "omni_view_content")) + map(select(.action_type == "view_content"))) | .[0].value // "0" | tonumber),
    link_clicks: ($actions | map(select(.action_type == "link_click")) | .[0].value // "0" | tonumber),
    landing_page_views: ($actions | map(select(.action_type == "landing_page_view")) | .[0].value // "0" | tonumber),
    # Engagement
    post_engagement: ($actions | map(select(.action_type == "post_engagement")) | .[0].value // "0" | tonumber),
    page_engagement: ($actions | map(select(.action_type == "page_engagement")) | .[0].value // "0" | tonumber),
    # Leads
    lead: ($actions | (map(select(.action_type == "onsite_conversion.lead_grouped")) + map(select(.action_type == "lead"))) | .[0].value // "0" | tonumber),
    # App
    app_install: ($actions | (map(select(.action_type == "omni_app_install")) + map(select(.action_type == "mobile_app_install")) + map(select(.action_type == "app_install"))) | .[0].value // "0" | tonumber),
    # Video
    video_view: ($actions | map(select(.action_type == "video_view")) | .[0].value // "0" | tonumber)
  } | . + {
    cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
    cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
    cpl: (if .lead > 0 then (.spend / .lead) else null end),
    cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
    link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
    link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end)
  }]' \
    "$DIR/campaigns.json" > "$DIR/campaigns-summary.json"
  echo "  campaigns-summary.json: $(wc -l < "$DIR/campaigns-summary.json" | tr -d ' ') lines"
fi

# Summarize adsets
if [[ -f "$DIR/adsets.json" ]]; then
  jq --slurpfile obj "$OBJ_LOOKUP" '[(.data // .)[] |
    # Attribution guard — filter out windowed duplicates, fall back to raw if all filtered
    ((.actions // []) as $raw_a | ($raw_a | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_a else . end) as $actions |
    ((.action_values // []) as $raw_av | ($raw_av | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_av else . end) as $action_vals |
    {
    adset_id: (.adset_id // null),
    adset_name: (.adset_name // null),
    campaign_id: (.campaign_id // null),
    campaign_name: (.campaign_name // null),
    objective: ((.campaign_id // "") | tostring | . as $cid | ($obj[0][$cid] // "UNKNOWN")),
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
    # Sales
    purchases: ($actions | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    revenue: ($action_vals | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    roas: ((.purchase_roas // []) | map(select(has("action_attribution_window") | not)) | if length == 0 then ((.purchase_roas // [])) else . end | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
    # Funnel
    add_to_cart: ($actions | (map(select(.action_type == "omni_add_to_cart")) + map(select(.action_type == "add_to_cart"))) | .[0].value // "0" | tonumber),
    initiate_checkout: ($actions | (map(select(.action_type == "omni_initiated_checkout")) + map(select(.action_type == "initiate_checkout"))) | .[0].value // "0" | tonumber),
    view_content: ($actions | (map(select(.action_type == "omni_view_content")) + map(select(.action_type == "view_content"))) | .[0].value // "0" | tonumber),
    link_clicks: ($actions | map(select(.action_type == "link_click")) | .[0].value // "0" | tonumber),
    landing_page_views: ($actions | map(select(.action_type == "landing_page_view")) | .[0].value // "0" | tonumber),
    # Engagement
    post_engagement: ($actions | map(select(.action_type == "post_engagement")) | .[0].value // "0" | tonumber),
    page_engagement: ($actions | map(select(.action_type == "page_engagement")) | .[0].value // "0" | tonumber),
    # Leads
    lead: ($actions | (map(select(.action_type == "onsite_conversion.lead_grouped")) + map(select(.action_type == "lead"))) | .[0].value // "0" | tonumber),
    # App
    app_install: ($actions | (map(select(.action_type == "omni_app_install")) + map(select(.action_type == "mobile_app_install")) + map(select(.action_type == "app_install"))) | .[0].value // "0" | tonumber),
    # Video
    video_view: ($actions | map(select(.action_type == "video_view")) | .[0].value // "0" | tonumber)
  } | . + {
    cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
    cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
    cpl: (if .lead > 0 then (.spend / .lead) else null end),
    cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
    link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
    link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end)
  }]' \
    "$DIR/adsets.json" > "$DIR/adsets-summary.json"
  echo "  adsets-summary.json: $(wc -l < "$DIR/adsets-summary.json" | tr -d ' ') lines"
fi

# Summarize ads — join with creative content from creatives.json
if [[ -f "$DIR/ads.json" ]]; then
  if [[ -f "$DIR/creatives.json" ]]; then
    # Build creative lookup: ad_id -> body + title only (URLs handled by prepare-analysis.sh from _raw/)
    jq 'INDEX((.data // .)[] ; .id) | map_values({
      creative_body: .creative_body,
      creative_title: .creative_title
    })' "$DIR/creatives.json" > "$DIR/_creative_lookup.json" 2>/dev/null || echo '{}' > "$DIR/_creative_lookup.json"

    jq --slurpfile creatives "$DIR/_creative_lookup.json" --slurpfile obj "$OBJ_LOOKUP" '[(.data // .)[] |
      ((.ad_id // "") | tostring) as $aid |
      # Attribution guard — filter out windowed duplicates, fall back to raw if all filtered
      ((.actions // []) as $raw_a | ($raw_a | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_a else . end) as $actions |
      ((.action_values // []) as $raw_av | ($raw_av | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_av else . end) as $action_vals |
      {
        ad_id: (.ad_id // null),
        ad_name: (.ad_name // null),
        adset_id: (.adset_id // null),
        campaign_id: (.campaign_id // null),
        campaign_name: (.campaign_name // null),
        objective: ((.campaign_id // "") | tostring | . as $cid | ($obj[0][$cid] // "UNKNOWN")),
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
        # Sales
        purchases: ($actions | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
        revenue: ($action_vals | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
        roas: ((.purchase_roas // []) | map(select(has("action_attribution_window") | not)) | if length == 0 then ((.purchase_roas // [])) else . end | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
        # Traffic/Funnel
        link_clicks: ($actions | map(select(.action_type == "link_click")) | .[0].value // "0" | tonumber),
        landing_page_views: ($actions | map(select(.action_type == "landing_page_view")) | .[0].value // "0" | tonumber),
        # Engagement
        post_engagement: ($actions | map(select(.action_type == "post_engagement")) | .[0].value // "0" | tonumber),
        page_engagement: ($actions | map(select(.action_type == "page_engagement")) | .[0].value // "0" | tonumber),
        # Leads
        lead: ($actions | (map(select(.action_type == "onsite_conversion.lead_grouped")) + map(select(.action_type == "lead"))) | .[0].value // "0" | tonumber),
        # App
        app_install: ($actions | (map(select(.action_type == "omni_app_install")) + map(select(.action_type == "mobile_app_install")) + map(select(.action_type == "app_install"))) | .[0].value // "0" | tonumber),
        # Video
        video_view: ($actions | map(select(.action_type == "video_view")) | .[0].value // "0" | tonumber),
        # Creative
        creative_body: (if $aid != "" then ($creatives[0][$aid].creative_body // "") else "" end),
        creative_title: (if $aid != "" then ($creatives[0][$aid].creative_title // "") else "" end)
      } | . + {
        cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
        cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
        cpl: (if .lead > 0 then (.spend / .lead) else null end),
        cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
        link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
        link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end)
      }]' \
      "$DIR/ads.json" > "$DIR/ads-summary.json"

    rm -f "$DIR/_creative_lookup.json"
  else
    jq --slurpfile obj "$OBJ_LOOKUP" '[(.data // .)[] |
      # Attribution guard — filter out windowed duplicates, fall back to raw if all filtered
      ((.actions // []) as $raw_a | ($raw_a | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_a else . end) as $actions |
      ((.action_values // []) as $raw_av | ($raw_av | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw_av else . end) as $action_vals |
      {
      ad_id: (.ad_id // null),
      ad_name: (.ad_name // null),
      adset_id: (.adset_id // null),
      campaign_id: (.campaign_id // null),
      campaign_name: (.campaign_name // null),
      objective: ((.campaign_id // "") | tostring | . as $cid | ($obj[0][$cid] // "UNKNOWN")),
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
      # Sales
      purchases: ($actions | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
      revenue: ($action_vals | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
      roas: ((.purchase_roas // []) | map(select(has("action_attribution_window") | not)) | if length == 0 then ((.purchase_roas // [])) else . end | (map(select(.action_type == "omni_purchase")) + map(select(.action_type == "purchase"))) | .[0].value // "0" | tonumber),
      # Traffic/Funnel
      link_clicks: ($actions | map(select(.action_type == "link_click")) | .[0].value // "0" | tonumber),
      landing_page_views: ($actions | map(select(.action_type == "landing_page_view")) | .[0].value // "0" | tonumber),
      # Engagement
      post_engagement: ($actions | map(select(.action_type == "post_engagement")) | .[0].value // "0" | tonumber),
      page_engagement: ($actions | map(select(.action_type == "page_engagement")) | .[0].value // "0" | tonumber),
      # Leads
      lead: ($actions | (map(select(.action_type == "onsite_conversion.lead_grouped")) + map(select(.action_type == "lead"))) | .[0].value // "0" | tonumber),
      # App
      app_install: ($actions | (map(select(.action_type == "omni_app_install")) + map(select(.action_type == "mobile_app_install")) + map(select(.action_type == "app_install"))) | .[0].value // "0" | tonumber),
      # Video
      video_view: ($actions | map(select(.action_type == "video_view")) | .[0].value // "0" | tonumber)
    } | . + {
      cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
      cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
      cpl: (if .lead > 0 then (.spend / .lead) else null end),
      cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
      link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
      link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end)
    }]' \
      "$DIR/ads.json" > "$DIR/ads-summary.json"
  fi
  echo "  ads-summary.json: $(wc -l < "$DIR/ads-summary.json" | tr -d ' ') lines"
fi

rm -f "$DIR/_objective_lookup.json"

echo "  Summarization complete for $(basename "$DIR")"
