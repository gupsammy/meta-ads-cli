#!/bin/bash
set -euo pipefail

# Compute per-objective performance defaults from campaign-level insights.
# Groups campaigns by normalized objective and computes KPIs for each.
#
# Usage: compute-defaults.sh <account_id> [campaigns-meta.json]
# Requires: meta-ads CLI, jq

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/jq-defs.sh
. "$SCRIPT_DIR/lib/jq-defs.sh"
OBJ_MAP="$SCRIPT_DIR/../references/objective-map.json"
ACCOUNT_ID="${1:?Usage: compute-defaults.sh <account_id> [campaigns-meta.json]}"
CAMPAIGNS_META_FILE="${2:-}"
CLI="${META_ADS_CLI:-meta-ads}"

if ! command -v jq &>/dev/null; then
  echo '{"error": "jq is required but not installed"}' >&2
  exit 1
fi

# Pull campaigns-meta if not provided (onboarding already has it)
if [[ -n "$CAMPAIGNS_META_FILE" && -f "$CAMPAIGNS_META_FILE" ]]; then
  CAMPAIGNS_META=$(cat "$CAMPAIGNS_META_FILE")
else
  CAMPAIGNS_META=$("$CLI" campaigns list --account-id "$ACCOUNT_ID" --limit 200 -o json)
fi

# Build objective lookup: campaign_id -> normalized objective (via objective-map.json)
OBJ_LOOKUP=$(echo "$CAMPAIGNS_META" | jq --slurpfile omap "$OBJ_MAP" '
  INDEX((.data // .)[]; .id) | map_values(
    (.objective // "UNKNOWN") as $v | $omap[0][$v] // $v
  )')

# Pull campaign-level insights for last 14 days
RAW=$("$CLI" insights get \
  --account-id "$ACCOUNT_ID" \
  --date-preset last_14d \
  --level campaign \
  -o json)

# Join with objectives, group by objective, compute per-objective KPIs
echo "$RAW" | jq --argjson obj "$OBJ_LOOKUP" "$JQ_DEFS"'
  [(.data // .)[] |
    ((.campaign_id // "") | tostring) as $cid |
    (.actions | attr_guard) as $actions |
    (.action_values | attr_guard) as $action_vals |
    {
      campaign_id: $cid,
      objective: ($obj[$cid] // "UNKNOWN"),
      spend: ((.spend // "0") | tonumber),
      impressions: ((.impressions // "0") | tonumber),
      clicks: ((.clicks // "0") | tonumber),
      cpc: ((.cpc // "0") | tonumber),
      ctr: ((.ctr // "0") | tonumber),
      cpm: ((.cpm // "0") | tonumber),
      reach: ((.reach // "0") | tonumber),
      frequency: ((.frequency // "0") | tonumber),
      purchases: ($actions | omni_first(["omni_purchase", "purchase"])),
      revenue: ($action_vals | omni_first(["omni_purchase", "purchase"])),
      roas: (.purchase_roas | attr_guard | omni_first(["omni_purchase", "purchase"])),
      link_clicks: ($actions | omni_first(["link_click"])),
      landing_page_views: ($actions | omni_first(["landing_page_view"])),
      post_engagement: ($actions | omni_first(["post_engagement"])),
      lead: ($actions | omni_first(["onsite_conversion.lead_grouped", "lead"])),
      app_install: ($actions | omni_first(["omni_app_install", "mobile_app_install", "app_install"])),
      video_view: ($actions | omni_first(["video_view"]))
    }
  ] |

  # Total spend across all campaigns
  (map(.spend) | add // 0) as $total_spend |

  # Group by objective and compute per-objective KPIs
  group_by(.objective) | map(
    .[0].objective as $obj |
    (map(.spend) | add // 0) as $spend |
    (length) as $count |
    {objective: $obj, campaign_count: $count, spend: $spend} +

    if $obj == "OUTCOME_SALES" then
      (map(.purchases) | add // 0) as $p |
      (map(.revenue) | add // 0) as $r |
      {
        purchases: $p,
        revenue: $r,
        current_cpa: (if $p > 0 then ($spend / $p | . * 100 | round / 100) else null end),
        current_roas: (if $spend > 0 then ($r / $spend | . * 100 | round / 100) else null end)
      }
    elif $obj == "OUTCOME_TRAFFIC" then
      (map(.link_clicks) | add // 0) as $lc |
      (map(.landing_page_views) | add // 0) as $lpv |
      (map(.impressions) | add // 0) as $imp |
      {
        link_clicks: $lc,
        landing_page_views: $lpv,
        current_cpc: (if $lc > 0 then ($spend / $lc | . * 100 | round / 100) else null end),
        current_link_ctr: (if $imp > 0 then ($lc / $imp * 100 | . * 100 | round / 100) else null end)
      }
    elif $obj == "OUTCOME_AWARENESS" then
      (map(.impressions) | add // 0) as $imp |
      (map(.reach) | add // 0) as $rch |
      (map(.video_view) | add // 0) as $vv |
      {
        impressions: $imp,
        reach: $rch,
        video_views: $vv,
        current_cpm: (if $imp > 0 then ($spend / $imp * 1000 | . * 100 | round / 100) else null end),
        current_cpv: (if $vv > 0 then ($spend / $vv | . * 100 | round / 100) else null end),
        avg_frequency: (if $rch > 0 then ($imp / $rch | . * 100 | round / 100) else null end)
      }
    elif $obj == "OUTCOME_ENGAGEMENT" then
      (map(.post_engagement) | add // 0) as $pe |
      (map(.impressions) | add // 0) as $imp |
      {
        post_engagement: $pe,
        current_cpe: (if $pe > 0 then ($spend / $pe | . * 100 | round / 100) else null end),
        engagement_rate: (if $imp > 0 then ($pe / $imp * 100 | . * 100 | round / 100) else null end)
      }
    elif $obj == "OUTCOME_LEADS" then
      (map(.lead) | add // 0) as $ld |
      {
        leads: $ld,
        current_cpl: (if $ld > 0 then ($spend / $ld | . * 100 | round / 100) else null end)
      }
    elif $obj == "OUTCOME_APP_PROMOTION" then
      (map(.app_install) | add // 0) as $ai |
      {
        app_installs: $ai,
        current_cpi: (if $ai > 0 then ($spend / $ai | . * 100 | round / 100) else null end)
      }
    else {} end
  ) |

  # Build output: objectives as keyed object
  {
    objectives: (map({(.objective): (del(.objective))}) | add // {}),
    total_spend: $total_spend,
    objectives_detected: (map(.objective) | sort)
  }
'
