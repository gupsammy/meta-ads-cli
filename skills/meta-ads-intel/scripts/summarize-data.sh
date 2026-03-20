#!/bin/bash
set -euo pipefail
umask 077

# Summarize raw Meta Ads JSON into compact agent-readable summaries.
# Extracts only the fields the agent needs from verbose actions arrays.
# Reduces file size by ~85-92%.
#
# Usage: summarize-data.sh <directory>
#   where <directory> contains campaigns.json, adsets.json, ads.json, creatives.json

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OBJ_MAP="$SCRIPT_DIR/../references/objective-map.json"
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

# Normalize legacy objectives to OUTCOME_* equivalents using objective-map.json
if [[ -f "$OBJ_LOOKUP" && -s "$OBJ_LOOKUP" ]]; then
  jq --slurpfile omap "$OBJ_MAP" 'map_values(. as $v | $omap[0][$v] // $v)' \
    "$OBJ_LOOKUP" > "${OBJ_LOOKUP}.tmp" && mv "${OBJ_LOOKUP}.tmp" "$OBJ_LOOKUP"
fi

# Summarize campaigns
if [[ -f "$DIR/campaigns.json" ]]; then
  jq --slurpfile obj "$OBJ_LOOKUP" '
    # Reusable defs: attribution guard + omni-first extraction (canonical definitions)
    def attr_guard: (. // []) as $raw | ($raw | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw else . end;
    def omni_first($types): [.[] | select(.action_type as $t | $types | index($t) != null)] | sort_by(.action_type as $t | $types | index($t)) | .[0].value // "0" | tonumber;
    def extract_metrics:
      (.actions | attr_guard) as $actions |
      (.action_values | attr_guard) as $action_vals |
      {
        spend: ((.spend // "0") | tonumber),
        impressions: ((.impressions // "0") | tonumber),
        clicks: ((.clicks // "0") | tonumber),
        cpc: ((.cpc // "0") | tonumber),
        ctr: ((.ctr // "0") | tonumber),
        cpm: ((.cpm // "0") | tonumber),
        frequency: ((.frequency // "0") | tonumber),
        reach: ((.reach // "0") | tonumber),
        purchases: ($actions | omni_first(["omni_purchase", "purchase"])),
        revenue: ($action_vals | omni_first(["omni_purchase", "purchase"])),
        roas: (.purchase_roas | attr_guard | omni_first(["omni_purchase", "purchase"])),
        add_to_cart: ($actions | omni_first(["omni_add_to_cart", "add_to_cart"])),
        initiate_checkout: ($actions | omni_first(["omni_initiated_checkout", "initiate_checkout"])),
        view_content: ($actions | omni_first(["omni_view_content", "view_content"])),
        link_clicks: ($actions | omni_first(["link_click"])),
        landing_page_views: ($actions | omni_first(["landing_page_view"])),
        post_engagement: ($actions | omni_first(["post_engagement"])),
        page_engagement: ($actions | omni_first(["page_engagement"])),
        lead: ($actions | omni_first(["onsite_conversion.lead_grouped", "lead"])),
        app_install: ($actions | omni_first(["omni_app_install", "mobile_app_install", "app_install"])),
        video_view: ($actions | omni_first(["video_view"]))
      };
    def add_derived:
      . + {
        cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
        cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
        cpl: (if .lead > 0 then (.spend / .lead) else null end),
        cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
        link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
        link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end)
      };
    [(.data // .)[] |
      extract_metrics + {
        campaign_id: (.campaign_id // null),
        campaign_name: (.campaign_name // null),
        objective: ((.campaign_id // "") | tostring | . as $cid | ($obj[0][$cid] // "UNKNOWN")),
        date_start,
        date_stop
      } | add_derived
    ]' "$DIR/campaigns.json" > "$DIR/campaigns-summary.json"
  echo "  campaigns-summary.json: $(wc -l < "$DIR/campaigns-summary.json" | tr -d ' ') lines"
fi

# Summarize adsets
if [[ -f "$DIR/adsets.json" ]]; then
  jq --slurpfile obj "$OBJ_LOOKUP" '
    def attr_guard: (. // []) as $raw | ($raw | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw else . end;
    def omni_first($types): [.[] | select(.action_type as $t | $types | index($t) != null)] | sort_by(.action_type as $t | $types | index($t)) | .[0].value // "0" | tonumber;
    def extract_metrics:
      (.actions | attr_guard) as $actions |
      (.action_values | attr_guard) as $action_vals |
      {
        spend: ((.spend // "0") | tonumber),
        impressions: ((.impressions // "0") | tonumber),
        clicks: ((.clicks // "0") | tonumber),
        cpc: ((.cpc // "0") | tonumber),
        ctr: ((.ctr // "0") | tonumber),
        cpm: ((.cpm // "0") | tonumber),
        frequency: ((.frequency // "0") | tonumber),
        reach: ((.reach // "0") | tonumber),
        purchases: ($actions | omni_first(["omni_purchase", "purchase"])),
        revenue: ($action_vals | omni_first(["omni_purchase", "purchase"])),
        roas: (.purchase_roas | attr_guard | omni_first(["omni_purchase", "purchase"])),
        add_to_cart: ($actions | omni_first(["omni_add_to_cart", "add_to_cart"])),
        initiate_checkout: ($actions | omni_first(["omni_initiated_checkout", "initiate_checkout"])),
        view_content: ($actions | omni_first(["omni_view_content", "view_content"])),
        link_clicks: ($actions | omni_first(["link_click"])),
        landing_page_views: ($actions | omni_first(["landing_page_view"])),
        post_engagement: ($actions | omni_first(["post_engagement"])),
        page_engagement: ($actions | omni_first(["page_engagement"])),
        lead: ($actions | omni_first(["onsite_conversion.lead_grouped", "lead"])),
        app_install: ($actions | omni_first(["omni_app_install", "mobile_app_install", "app_install"])),
        video_view: ($actions | omni_first(["video_view"]))
      };
    def add_derived:
      . + {
        cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
        cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
        cpl: (if .lead > 0 then (.spend / .lead) else null end),
        cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
        link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
        link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end)
      };
    [(.data // .)[] |
      extract_metrics + {
        adset_id: (.adset_id // null),
        adset_name: (.adset_name // null),
        campaign_id: (.campaign_id // null),
        campaign_name: (.campaign_name // null),
        objective: ((.campaign_id // "") | tostring | . as $cid | ($obj[0][$cid] // "UNKNOWN")),
        date_start,
        date_stop
      } | add_derived
    ]' "$DIR/adsets.json" > "$DIR/adsets-summary.json"
  echo "  adsets-summary.json: $(wc -l < "$DIR/adsets-summary.json" | tr -d ' ') lines"
fi

# Summarize ads — always build creative lookup (empty {} if no creatives.json)
if [[ -f "$DIR/ads.json" ]]; then
  if [[ -f "$DIR/creatives.json" ]]; then
    jq 'INDEX((.data // .)[] ; .id) | map_values({
      creative_body: .creative_body,
      creative_title: .creative_title
    })' "$DIR/creatives.json" > "$DIR/_creative_lookup.json" 2>/dev/null || echo '{}' > "$DIR/_creative_lookup.json"
  else
    echo '{}' > "$DIR/_creative_lookup.json"
  fi

  jq --slurpfile creatives "$DIR/_creative_lookup.json" --slurpfile obj "$OBJ_LOOKUP" '
    def attr_guard: (. // []) as $raw | ($raw | map(select(has("action_attribution_window") | not))) | if length == 0 then $raw else . end;
    def omni_first($types): [.[] | select(.action_type as $t | $types | index($t) != null)] | sort_by(.action_type as $t | $types | index($t)) | .[0].value // "0" | tonumber;
    def extract_metrics:
      (.actions | attr_guard) as $actions |
      (.action_values | attr_guard) as $action_vals |
      {
        spend: ((.spend // "0") | tonumber),
        impressions: ((.impressions // "0") | tonumber),
        clicks: ((.clicks // "0") | tonumber),
        cpc: ((.cpc // "0") | tonumber),
        ctr: ((.ctr // "0") | tonumber),
        cpm: ((.cpm // "0") | tonumber),
        frequency: ((.frequency // "0") | tonumber),
        reach: ((.reach // "0") | tonumber),
        purchases: ($actions | omni_first(["omni_purchase", "purchase"])),
        revenue: ($action_vals | omni_first(["omni_purchase", "purchase"])),
        roas: (.purchase_roas | attr_guard | omni_first(["omni_purchase", "purchase"])),
        add_to_cart: ($actions | omni_first(["omni_add_to_cart", "add_to_cart"])),
        initiate_checkout: ($actions | omni_first(["omni_initiated_checkout", "initiate_checkout"])),
        view_content: ($actions | omni_first(["omni_view_content", "view_content"])),
        link_clicks: ($actions | omni_first(["link_click"])),
        landing_page_views: ($actions | omni_first(["landing_page_view"])),
        post_engagement: ($actions | omni_first(["post_engagement"])),
        page_engagement: ($actions | omni_first(["page_engagement"])),
        lead: ($actions | omni_first(["onsite_conversion.lead_grouped", "lead"])),
        app_install: ($actions | omni_first(["omni_app_install", "mobile_app_install", "app_install"])),
        video_view: ($actions | omni_first(["video_view"]))
      };
    def add_derived:
      . + {
        cpa: (if .purchases > 0 then (.spend / .purchases) else null end),
        cpe: (if .post_engagement > 0 then (.spend / .post_engagement) else null end),
        cpl: (if .lead > 0 then (.spend / .lead) else null end),
        cpi: (if .app_install > 0 then (.spend / .app_install) else null end),
        link_click_ctr: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else 0 end),
        link_click_cpc: (if .link_clicks > 0 then (.spend / .link_clicks | . * 100 | round / 100) else null end)
      };
    [(.data // .)[] |
      ((.ad_id // "") | tostring) as $aid |
      extract_metrics + {
        ad_id: (.ad_id // null),
        ad_name: (.ad_name // null),
        adset_id: (.adset_id // null),
        campaign_id: (.campaign_id // null),
        campaign_name: (.campaign_name // null),
        objective: ((.campaign_id // "") | tostring | . as $cid | ($obj[0][$cid] // "UNKNOWN")),
        date_start,
        date_stop,
        creative_body: (if $aid != "" then ($creatives[0][$aid].creative_body // "") else "" end),
        creative_title: (if $aid != "" then ($creatives[0][$aid].creative_title // "") else "" end)
      } | add_derived
    ]' "$DIR/ads.json" > "$DIR/ads-summary.json"

  rm -f "$DIR/_creative_lookup.json"
  echo "  ads-summary.json: $(wc -l < "$DIR/ads-summary.json" | tr -d ' ') lines"
fi

rm -f "$DIR/_objective_lookup.json"

echo "  Summarization complete for $(basename "$DIR")"
