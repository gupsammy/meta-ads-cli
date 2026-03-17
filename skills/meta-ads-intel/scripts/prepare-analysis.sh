#!/bin/bash
set -e

# Transform summary files + config into 6 agent-ready analysis files.
# All computation is pure jq — deterministic, fast, zero token cost.
#
# Usage: prepare-analysis.sh <run-dir>
#   where <run-dir> contains *-summary.json files and optionally _recent/ subdir
#
# Reads: ~/.meta-ads-intel/config.json for targets and analysis params
# Produces: account-health.json, budget-actions.json, funnel.json,
#           trends.json, creative-analysis.json, creative-media.json

RUN_DIR="$1"
if [[ -z "$RUN_DIR" || ! -d "$RUN_DIR" ]]; then
  echo "Usage: prepare-analysis.sh <run-dir>" >&2
  exit 1
fi

CONFIG="${META_ADS_CONFIG:-$HOME/.meta-ads-intel/config.json}"
if [[ ! -f "$CONFIG" ]]; then
  echo "Error: config.json not found at $CONFIG. Run onboarding first." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed." >&2
  exit 1
fi

# Load config values
TARGET_CPA=$(jq -r '.targets.cpa // 0' "$CONFIG")
TARGET_ROAS=$(jq -r '.targets.roas // 0' "$CONFIG")
MAX_FREQUENCY=$(jq -r '.targets.max_frequency // 5.0' "$CONFIG")
MIN_SPEND=$(jq -r '.targets.min_spend // 0' "$CONFIG")
TOP_N=$(jq -r '.analysis.top_n // 15' "$CONFIG")
BOTTOM_N=$(jq -r '.analysis.bottom_n // 10' "$CONFIG")
ZERO_N=$(jq -r '.analysis.zero_purchase_n // 10' "$CONFIG")
ACCOUNT_NAME=$(jq -r '.account_name // "Unknown"' "$CONFIG")
CURRENCY=$(jq -r '.currency // "USD"' "$CONFIG")

echo "Preparing analysis files for $(basename "$RUN_DIR")..."

# ─── 1. account-health.json ───────────────────────────────────────────────────
if [[ -f "$RUN_DIR/campaigns-summary.json" ]]; then
  jq --arg name "$ACCOUNT_NAME" --arg currency "$CURRENCY" \
     --argjson target_cpa "$TARGET_CPA" --argjson target_roas "$TARGET_ROAS" '
    {
      account_name: $name,
      currency: $currency,
      campaign_count: length,
      total_spend: (map(.spend) | add // 0),
      total_purchases: (map(.purchases) | add // 0),
      total_revenue: (map(.revenue) | add // 0),
      total_impressions: (map(.impressions) | add // 0),
      total_reach: (map(.reach) | add // 0)
    } | . + {
      blended_cpa: (if .total_purchases > 0 then (.total_spend / .total_purchases | . * 100 | round / 100) else null end),
      blended_roas: (if .total_spend > 0 then (.total_revenue / .total_spend | . * 100 | round / 100) else null end),
      target_cpa: $target_cpa,
      target_roas: $target_roas,
      cpa_vs_target: (if .total_purchases > 0 and $target_cpa > 0 then
        (((.total_spend / .total_purchases) - $target_cpa) / $target_cpa * 100 | round)
      else null end),
      roas_vs_target: (if .total_spend > 0 and $target_roas > 0 then
        (((.total_revenue / .total_spend) - $target_roas) / $target_roas * 100 | round)
      else null end)
    }' "$RUN_DIR/campaigns-summary.json" > "$RUN_DIR/account-health.json"
  echo "  account-health.json"
fi

# ─── 2. budget-actions.json ───────────────────────────────────────────────────
if [[ -f "$RUN_DIR/adsets-summary.json" ]]; then
  jq --argjson target_cpa "$TARGET_CPA" --argjson target_roas "$TARGET_ROAS" \
     --argjson max_freq "$MAX_FREQUENCY" --argjson min_spend "$MIN_SPEND" \
     --argjson top_maintain 3 '

    # Classify each adset
    [.[] | select(.spend >= $min_spend)] |

    map(
      . + {
        action: (
          if .frequency > $max_freq then "refresh"
          elif .purchases == 0 then "pause"
          elif $target_roas > 0 and $target_cpa > 0 then (
            if .roas > ($target_roas * 1.2) and (.cpa != null and .cpa < ($target_cpa * 0.8)) then "scale"
            elif .roas < ($target_roas * 0.8) or (.cpa != null and .cpa > ($target_cpa * 1.2)) then "reduce"
            else "maintain"
            end
          )
          elif $target_roas > 0 then (
            if .roas > ($target_roas * 1.2) then "scale"
            elif .roas < ($target_roas * 0.8) then "reduce"
            else "maintain"
            end
          )
          elif $target_cpa > 0 then (
            if .cpa != null and .cpa < ($target_cpa * 0.8) then "scale"
            elif .cpa != null and .cpa > ($target_cpa * 1.2) then "reduce"
            else "maintain"
            end
          )
          else "maintain"
          end
        ),
        reason: (
          if .frequency > $max_freq then ("frequency " + (.frequency | tostring) + " exceeds ceiling " + ($max_freq | tostring))
          elif .purchases == 0 then ("zero purchases with spend " + (.spend | tostring))
          elif $target_roas > 0 and .roas > ($target_roas * 1.2) and (.cpa != null and .cpa < ($target_cpa * 0.8)) then
            ("ROAS " + (.roas | . * 100 | round / 100 | tostring) + " above target, CPA " + (.cpa | round | tostring) + " below target")
          elif $target_roas > 0 and .roas < ($target_roas * 0.8) then
            ("ROAS " + (.roas | . * 100 | round / 100 | tostring) + " below " + ($target_roas * 0.8 | . * 100 | round / 100 | tostring) + " threshold")
          elif $target_cpa > 0 and .cpa != null and .cpa > ($target_cpa * 1.2) then
            ("CPA " + (.cpa | round | tostring) + " above " + ($target_cpa * 1.2 | round | tostring) + " threshold")
          else "within target range"
          end
        )
      } |
      # Keep only agent-useful fields
      {
        adset_name, campaign_name, action, reason,
        spend, roas: (.roas | . * 100 | round / 100),
        cpa: (if .cpa then (.cpa | . * 100 | round / 100) else null end),
        purchases, frequency: (.frequency | . * 100 | round / 100)
      }
    ) |

    # Split by action type
    {
      scale: [.[] | select(.action == "scale")],
      reduce: [.[] | select(.action == "reduce")],
      pause: [.[] | select(.action == "pause")],
      refresh: [.[] | select(.action == "refresh")],
      maintain: {
        count: [.[] | select(.action == "maintain")] | length,
        top_by_spend: [.[] | select(.action == "maintain")] | sort_by(-.spend) | .[:$top_maintain]
      },
      summary: {
        total_evaluated: length,
        scale: ([.[] | select(.action == "scale")] | length),
        reduce: ([.[] | select(.action == "reduce")] | length),
        pause: ([.[] | select(.action == "pause")] | length),
        refresh: ([.[] | select(.action == "refresh")] | length),
        maintain: ([.[] | select(.action == "maintain")] | length)
      }
    }' "$RUN_DIR/adsets-summary.json" > "$RUN_DIR/budget-actions.json"
  echo "  budget-actions.json"
fi

# ─── 3. funnel.json ──────────────────────────────────────────────────────────
if [[ -f "$RUN_DIR/campaigns-summary.json" ]]; then
  jq '{
    impressions: (map(.impressions) | add // 0),
    link_clicks: (map(.link_clicks) | add // 0),
    landing_page_views: (map(.landing_page_views) | add // 0),
    view_content: (map(.view_content) | add // 0),
    add_to_cart: (map(.add_to_cart) | add // 0),
    initiate_checkout: (map(.initiate_checkout) | add // 0),
    purchases: (map(.purchases) | add // 0)
  } | . + {
    rates: {
      click_rate: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else null end),
      landing_rate: (if .link_clicks > 0 then (.landing_page_views / .link_clicks * 100 | . * 100 | round / 100) else null end),
      view_to_cart: (if .view_content > 0 then (.add_to_cart / .view_content * 100 | . * 100 | round / 100) else null end),
      cart_to_checkout: (if .add_to_cart > 0 then (.initiate_checkout / .add_to_cart * 100 | . * 100 | round / 100) else null end),
      checkout_to_purchase: (if .initiate_checkout > 0 then (.purchases / .initiate_checkout * 100 | . * 100 | round / 100) else null end)
    }
  } | . + {
    bottleneck: (
      [
        {stage: "TOFU_click", label: "impression → click", rate: .rates.click_rate},
        {stage: "TOFU_landing", label: "click → landing page", rate: .rates.landing_rate},
        {stage: "MOFU_view_to_cart", label: "view content → add to cart", rate: .rates.view_to_cart},
        {stage: "BOFU_cart_to_checkout", label: "add to cart → checkout", rate: .rates.cart_to_checkout},
        {stage: "BOFU_checkout_to_purchase", label: "checkout → purchase", rate: .rates.checkout_to_purchase}
      ] | map(select(.rate != null and .rate > 0)) | sort_by(.rate) | .[0] // null
    )
  }' "$RUN_DIR/campaigns-summary.json" > "$RUN_DIR/funnel.json"
  echo "  funnel.json"
fi

# ─── 4. trends.json ──────────────────────────────────────────────────────────
if [[ -d "$RUN_DIR/_recent" && -f "$RUN_DIR/_recent/campaigns-summary.json" && -f "$RUN_DIR/campaigns-summary.json" ]]; then
  jq --slurpfile recent "$RUN_DIR/_recent/campaigns-summary.json" '

    # Build lookup of recent data by campaign_id
    ($recent[0] | INDEX(.campaign_id)) as $recent_idx |

    # Period date range (from first campaign entry)
    (if length > 0 then .[0].date_start else null end) as $period_start |
    (if length > 0 then .[0].date_stop else null end) as $period_stop |
    ($recent[0] | if length > 0 then .[0].date_start else null end) as $recent_start |
    ($recent[0] | if length > 0 then .[0].date_stop else null end) as $recent_stop |

    {
      available: true,
      period: {start: $period_start, stop: $period_stop},
      recent: {start: $recent_start, stop: $recent_stop},
      campaigns: [
        .[] | select(.campaign_id != null) |
        . as $period |
        ($recent_idx[.campaign_id] // null) as $recent_data |
        if $recent_data then
          {
            campaign_name: .campaign_name,
            campaign_id: .campaign_id,
            period_spend: .spend,
            recent_spend: $recent_data.spend,
            period_cpa: .cpa,
            recent_cpa: $recent_data.cpa,
            period_roas: (.roas | . * 100 | round / 100),
            recent_roas: ($recent_data.roas | . * 100 | round / 100),
            period_frequency: (.frequency | . * 100 | round / 100),
            recent_frequency: ($recent_data.frequency | . * 100 | round / 100),
            cpa_delta_pct: (
              if .cpa != null and .cpa > 0 and $recent_data.cpa != null then
                (($recent_data.cpa - .cpa) / .cpa * 100 | round)
              else null end
            ),
            roas_delta_pct: (
              if .roas > 0 and $recent_data.roas != null then
                (($recent_data.roas - .roas) / .roas * 100 | round)
              else null end
            ),
            frequency_delta_pct: (
              if .frequency > 0 and $recent_data.frequency != null then
                (($recent_data.frequency - .frequency) / .frequency * 100 | round)
              else null end
            )
          } | . + {
            flags: [
              (if .roas_delta_pct != null and .roas_delta_pct < -15 then "roas_declining" else null end),
              (if .cpa_delta_pct != null and .cpa_delta_pct > 15 then "cpa_rising" else null end),
              (if .frequency_delta_pct != null and .frequency_delta_pct > 20 then "frequency_rising" else null end)
            ] | map(select(. != null))
          }
        else empty end
      ],
      flagged: [
        .[] | select(.campaign_id != null) |
        ($recent_idx[.campaign_id] // null) as $recent_data |
        if $recent_data then
          {
            campaign_name: .campaign_name,
            roas_delta: (if .roas > 0 then (($recent_data.roas - .roas) / .roas * 100 | round) else null end),
            cpa_delta: (if .cpa != null and .cpa > 0 and $recent_data.cpa != null then (($recent_data.cpa - .cpa) / .cpa * 100 | round) else null end)
          } | select(
            (.roas_delta != null and .roas_delta < -15) or
            (.cpa_delta != null and .cpa_delta > 15)
          )
        else empty end
      ]
    }' "$RUN_DIR/campaigns-summary.json" > "$RUN_DIR/trends.json"
  echo "  trends.json"
else
  echo '{"available": false, "reason": "no recent window data"}' > "$RUN_DIR/trends.json"
  echo "  trends.json (no recent data)"
fi

# ─── 5. creative-analysis.json ────────────────────────────────────────────────
if [[ -f "$RUN_DIR/ads-summary.json" ]]; then
  jq --argjson min_spend "$MIN_SPEND" --argjson top_n "$TOP_N" \
     --argjson bottom_n "$BOTTOM_N" --argjson zero_n "$ZERO_N" '

    # Filter by min spend
    [.[] | select(.spend >= $min_spend)] |

    # Separate ads with and without purchases
    (map(select(.purchases > 0)) | sort_by(-.roas)) as $with_purchases |
    (map(select(.purchases == 0)) | sort_by(-.spend)) as $zero_purchase |

    {
      overview: {
        total_ads: length,
        above_threshold: length,
        with_purchases: ($with_purchases | length),
        zero_purchase_count: ($zero_purchase | length),
        zero_purchase_total_spend: ($zero_purchase | map(.spend) | add // 0)
      },
      winners: [$with_purchases[:$top_n][] | {
        ad_name, campaign_name, creative_body, creative_title,
        spend, roas: (.roas | . * 100 | round / 100),
        cpa: (if .cpa then (.cpa | . * 100 | round / 100) else null end),
        purchases
      }],
      losers: [$with_purchases[-$bottom_n:][] | {
        ad_name, campaign_name, creative_body, creative_title,
        spend, roas: (.roas | . * 100 | round / 100),
        cpa: (if .cpa then (.cpa | . * 100 | round / 100) else null end),
        purchases
      }],
      zero_purchase: [$zero_purchase[:$zero_n][] | {
        ad_name, campaign_name, creative_body, creative_title,
        spend
      }]
    }' "$RUN_DIR/ads-summary.json" > "$RUN_DIR/creative-analysis.json"
  echo "  creative-analysis.json"
fi

# ─── 6. creative-media.json ──────────────────────────────────────────────────
# Built from ads-summary.json (has ad_id) + _raw/creatives.json (has URLs).
# Uses the same top/bottom/zero filtering as creative-analysis.json.
# analyze-creatives.sh needs ad_id to look up creative_id from creatives-master.json.
if [[ -f "$RUN_DIR/ads-summary.json" && -f "$RUN_DIR/_raw/creatives.json" ]]; then
  jq --argjson min_spend "$MIN_SPEND" --argjson top_n "$TOP_N" \
     --argjson bottom_n "$BOTTOM_N" --argjson zero_n "$ZERO_N" \
     --slurpfile creatives "$RUN_DIR/_raw/creatives.json" '

    # Build URL lookup from raw creatives: ad_id -> {image_url, thumbnail_url}
    ($creatives[0] | (.data // .) | INDEX(.id) | map_values({
      creative_image_url: (.creative_image_url // ""),
      creative_thumbnail_url: (.creative_thumbnail_url // "")
    })) as $url_lookup |

    # Same filtering logic as creative-analysis.json
    [.[] | select(.spend >= $min_spend)] |
    (map(select(.purchases > 0)) | sort_by(-.roas)) as $with_purchases |
    (map(select(.purchases == 0)) | sort_by(-.spend)) as $zero_purchase |

    # Tag and collect selected ads (preserving ad_id)
    [
      ($with_purchases[:$top_n][]   | . + {rank: "winner"}),
      ($with_purchases[-$bottom_n:][] | . + {rank: "loser"}),
      ($zero_purchase[:$zero_n][]   | . + {rank: "zero_purchase"})
    ] | map(
      (.ad_id | tostring) as $aid |
      {
        ad_id: .ad_id,
        ad_name: .ad_name,
        rank: .rank,
        roas: (.roas | . * 100 | round / 100),
        cpa: (if .cpa then (.cpa | . * 100 | round / 100) else null end),
        spend: .spend,
        creative_image_url: ($url_lookup[$aid].creative_image_url // ""),
        creative_thumbnail_url: ($url_lookup[$aid].creative_thumbnail_url // "")
      }
    )
  ' "$RUN_DIR/ads-summary.json" > "$RUN_DIR/creative-media.json"
  echo "  creative-media.json"
else
  echo '[]' > "$RUN_DIR/creative-media.json"
  echo "  creative-media.json (no creative data available)"
fi

echo "Analysis preparation complete."
