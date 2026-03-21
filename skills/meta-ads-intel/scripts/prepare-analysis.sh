#!/bin/bash
set -euo pipefail
umask 077

# Transform summary files + config into 6 agent-ready analysis files.
# All computation is pure jq — deterministic, fast, zero token cost.
# Per-objective analysis: each file groups data by campaign objective.
#
# Usage: prepare-analysis.sh <run-dir>
#   where <run-dir> contains *-summary.json files and optionally _recent/ subdir
#
# Reads: ~/.meta-ads-intel/config.json for targets and analysis params
# Produces: account-health.json, budget-actions.json, funnel.json,
#           trends.json, creative-analysis.json, creative-media.json

RUN_DIR="${1:-}"
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

# Validate that a JSON file exists, is non-empty, and is valid JSON
validate_json() {
  local file="$1" label="$2"
  if [[ ! -f "$file" ]]; then
    echo "Error: $label not found: $file" >&2
    return 1
  fi
  if [[ ! -s "$file" ]]; then
    echo "Error: $label is empty: $file" >&2
    return 1
  fi
  if ! jq empty "$file" 2>/dev/null; then
    echo "Error: $label is not valid JSON: $file" >&2
    return 1
  fi
}

# Require v2 config (per-objective targets from onboarding v2)
CONFIG_VER=$(jq -r '.config_version // 1' "$CONFIG")
if [[ "$CONFIG_VER" -lt 2 ]]; then
  echo "Error: config.json is v1 format. Re-run onboarding to upgrade to v2 (per-objective targets)." >&2
  exit 1
fi

# Load shared config values (single jq call)
read -r TOP_N BOTTOM_N ZERO_N ACCOUNT_NAME CURRENCY PRIMARY_OBJ < <(
  jq -r '[
    (.analysis.top_n // 15),
    (.analysis.bottom_n // 10),
    (.analysis.zero_conversion_n // .analysis.zero_purchase_n // 10),
    (.account_name // "Unknown"),
    (.currency // "USD"),
    (.primary_objective // "OUTCOME_SALES")
  ] | @tsv' "$CONFIG"
)

echo "Preparing analysis files for $(basename "$RUN_DIR")..."

# Validate input summary files before processing
for f in campaigns-summary.json adsets-summary.json ads-summary.json; do
  if [[ -f "$RUN_DIR/$f" ]]; then
    validate_json "$RUN_DIR/$f" "$f" || exit 1
  fi
done

# ─── 1. account-health.json ───────────────────────────────────────────────────
if [[ -f "$RUN_DIR/campaigns-summary.json" ]]; then
  jq --arg name "$ACCOUNT_NAME" --arg currency "$CURRENCY" --arg primary "$PRIMARY_OBJ" \
     --slurpfile cfg "$CONFIG" '

    ($cfg[0].targets // {}) as $targets |
    . as $all |
    ([.[].objective] | unique | sort) as $objectives |

    # Total aggregates
    ($all | map(.spend) | add // 0) as $total_spend |
    ($all | map(.impressions) | add // 0) as $total_impressions |
    ($all | map(.reach) | add // 0) as $total_reach |

    {
      account_name: $name,
      currency: $currency,
      primary_objective: $primary,
      objectives_present: $objectives,
      total_spend: $total_spend,
      total_impressions: $total_impressions,
      total_reach: $total_reach
    } + (
      # Per-objective sections
      [$objectives[] as $obj |
        [$all[] | select(.objective == $obj)] |
        ($targets[$obj] // {}) as $obj_targets |
        (map(.spend) | add // 0) as $spend |
        (map(.impressions) | add // 0) as $imp |
        (map(.reach) | add // 0) as $rch |

        {($obj): (
          {
            campaign_count: length,
            spend: $spend,
            impressions: $imp,
            reach: $rch
          } +

          if $obj == "OUTCOME_SALES" then
            (map(.purchases) | add // 0) as $p |
            (map(.revenue) | add // 0) as $r |
            ($obj_targets.cpa // 0) as $t_cpa |
            ($obj_targets.roas // 0) as $t_roas |
            {
              purchases: $p,
              revenue: $r,
              cpa: (if $p > 0 then ($spend / $p | . * 100 | round / 100) else null end),
              roas: (if $spend > 0 then ($r / $spend | . * 100 | round / 100) else null end),
              target_cpa: $t_cpa,
              target_roas: $t_roas,
              cpa_vs_target: (if $p > 0 and $t_cpa > 0 then
                ((($spend / $p) - $t_cpa) / $t_cpa * 100 | round) else null end),
              roas_vs_target: (if $spend > 0 and $t_roas > 0 then
                ((($r / $spend) - $t_roas) / $t_roas * 100 | round) else null end)
            }

          elif $obj == "OUTCOME_TRAFFIC" then
            (map(.link_clicks) | add // 0) as $lc |
            (map(.landing_page_views) | add // 0) as $lpv |
            ($obj_targets.cpc // 0) as $t_cpc |
            ($obj_targets.ctr // $obj_targets.target_ctr // 0) as $t_ctr |
            {
              link_clicks: $lc,
              landing_page_views: $lpv,
              cpc: (if $lc > 0 then ($spend / $lc | . * 100 | round / 100) else null end),
              ctr: (if $imp > 0 then ($lc / $imp * 100 | . * 100 | round / 100) else null end),
              target_cpc: $t_cpc,
              target_ctr: $t_ctr,
              cpc_vs_target: (if $lc > 0 and $t_cpc > 0 then
                ((($spend / $lc) - $t_cpc) / $t_cpc * 100 | round) else null end),
              ctr_vs_target: (if $imp > 0 and $t_ctr > 0 then
                ((($lc / $imp * 100) - $t_ctr) / $t_ctr * 100 | round) else null end)
            }

          elif $obj == "OUTCOME_AWARENESS" then
            ($obj_targets.cpm // 0) as $t_cpm |
            ($obj_targets.max_frequency // ($targets.global.max_frequency // 5.0)) as $t_freq |
            {
              cpm: (if $imp > 0 then ($spend / $imp * 1000 | . * 100 | round / 100) else null end),
              avg_frequency: (if $rch > 0 then ($imp / $rch | . * 100 | round / 100) else null end),
              reach_rate: (if $imp > 0 then ($rch / $imp * 100 | . * 100 | round / 100) else null end),
              target_cpm: $t_cpm,
              target_max_frequency: $t_freq,
              cpm_vs_target: (if $imp > 0 and $t_cpm > 0 then
                ((($spend / $imp * 1000) - $t_cpm) / $t_cpm * 100 | round) else null end)
            }

          elif $obj == "OUTCOME_ENGAGEMENT" then
            (map(.post_engagement) | add // 0) as $pe |
            (map(.page_engagement) | add // 0) as $pge |
            ($obj_targets.cpe // 0) as $t_cpe |
            ($obj_targets.engagement_rate // $obj_targets.target_engagement_rate // 0) as $t_er |
            {
              post_engagement: $pe,
              page_engagement: $pge,
              cpe: (if $pe > 0 then ($spend / $pe | . * 100 | round / 100) else null end),
              engagement_rate: (if $imp > 0 then ($pe / $imp * 100 | . * 100 | round / 100) else null end),
              target_cpe: $t_cpe,
              target_engagement_rate: $t_er,
              cpe_vs_target: (if $pe > 0 and $t_cpe > 0 then
                ((($spend / $pe) - $t_cpe) / $t_cpe * 100 | round) else null end)
            }

          elif $obj == "OUTCOME_LEADS" then
            (map(.lead) | add // 0) as $ld |
            ($obj_targets.cpl // 0) as $t_cpl |
            {
              leads: $ld,
              cpl: (if $ld > 0 then ($spend / $ld | . * 100 | round / 100) else null end),
              target_cpl: $t_cpl,
              cpl_vs_target: (if $ld > 0 and $t_cpl > 0 then
                ((($spend / $ld) - $t_cpl) / $t_cpl * 100 | round) else null end)
            }

          elif $obj == "OUTCOME_APP_PROMOTION" then
            (map(.app_install) | add // 0) as $ai |
            ($obj_targets.cpi // 0) as $t_cpi |
            {
              app_installs: $ai,
              cpi: (if $ai > 0 then ($spend / $ai | . * 100 | round / 100) else null end),
              target_cpi: $t_cpi,
              cpi_vs_target: (if $ai > 0 and $t_cpi > 0 then
                ((($spend / $ai) - $t_cpi) / $t_cpi * 100 | round) else null end)
            }

          else {} end
        )}
      ] | add // {}
    )' "$RUN_DIR/campaigns-summary.json" > "$RUN_DIR/account-health.json"
  echo "  account-health.json"
fi

# ─── 2. budget-actions.json ───────────────────────────────────────────────────
if [[ -f "$RUN_DIR/adsets-summary.json" ]]; then
  jq --slurpfile cfg "$CONFIG" --argjson top_maintain 3 '

    ($cfg[0].targets // {}) as $targets |
    ($targets.global.max_frequency // 5.0) as $global_max_freq |
    ($targets.global.min_spend // 0) as $min_spend |

    # Group by objective
    ([.[].objective] | unique | sort) as $objectives |

    {objectives_present: $objectives} + (
      [$objectives[] as $obj |
        ($targets[$obj] // {}) as $obj_targets |
        # Awareness uses its own max_frequency if set
        (if $obj == "OUTCOME_AWARENESS" then ($obj_targets.max_frequency // $global_max_freq)
         else $global_max_freq end) as $max_freq |

        [.[] | select(.objective == $obj and .spend >= $min_spend)] |

        map(
          # Classify based on objective-appropriate KPIs
          . + (
            if .frequency > $max_freq then
              {action: "refresh", reason: ("frequency " + (.frequency | tostring) + " exceeds ceiling " + ($max_freq | tostring))}

            elif $obj == "OUTCOME_SALES" then (
              ($obj_targets.roas // 0) as $t_roas |
              ($obj_targets.cpa // 0) as $t_cpa |
              if .purchases == 0 then
                {action: "pause", reason: ("zero purchases with spend " + (.spend | tostring))}
              elif $t_roas > 0 and $t_cpa > 0 then (
                if .roas > ($t_roas * 1.2) and (.cpa != null and .cpa < ($t_cpa * 0.8)) then
                  {action: "scale", reason: ("ROAS " + (.roas | . * 100 | round / 100 | tostring) + " above target, CPA " + (.cpa | round | tostring) + " below target")}
                elif .roas < ($t_roas * 0.8) or (.cpa != null and .cpa > ($t_cpa * 1.2)) then
                  {action: "reduce", reason: (
                    if .roas < ($t_roas * 0.8) then "ROAS " + (.roas | . * 100 | round / 100 | tostring) + " below threshold"
                    else "CPA " + (.cpa | round | tostring) + " above threshold" end)}
                else {action: "maintain", reason: "within target range"} end)
              elif $t_roas > 0 then (
                if .roas > ($t_roas * 1.2) then {action: "scale", reason: ("ROAS " + (.roas | . * 100 | round / 100 | tostring) + " above target")}
                elif .roas < ($t_roas * 0.8) then {action: "reduce", reason: ("ROAS " + (.roas | . * 100 | round / 100 | tostring) + " below threshold")}
                else {action: "maintain", reason: "within target range"} end)
              elif $t_cpa > 0 then (
                if .cpa != null and .cpa < ($t_cpa * 0.8) then {action: "scale", reason: ("CPA " + (.cpa | round | tostring) + " below target")}
                elif .cpa != null and .cpa > ($t_cpa * 1.2) then {action: "reduce", reason: ("CPA " + (.cpa | round | tostring) + " above threshold")}
                else {action: "maintain", reason: "within target range"} end)
              else {action: "maintain", reason: "no targets set"} end
            )

            elif $obj == "OUTCOME_TRAFFIC" then (
              ($obj_targets.cpc // 0) as $t_cpc |
              ($obj_targets.ctr // $obj_targets.target_ctr // 0) as $t_ctr |
              if .link_clicks == 0 then
                {action: "pause", reason: ("zero link clicks with spend " + (.spend | tostring))}
              elif $t_cpc > 0 and $t_ctr > 0 then (
                if .link_click_cpc != null and .link_click_cpc < ($t_cpc * 0.8) and .link_click_ctr > ($t_ctr * 1.2) then
                  {action: "scale", reason: ("CPC " + (.link_click_cpc | . * 100 | round / 100 | tostring) + " below target, CTR " + (.link_click_ctr | . * 100 | round / 100 | tostring) + "% above target")}
                elif (.link_click_cpc != null and .link_click_cpc > ($t_cpc * 1.2)) or .link_click_ctr < ($t_ctr * 0.8) then
                  {action: "reduce", reason: (
                    if .link_click_cpc != null and .link_click_cpc > ($t_cpc * 1.2) then "CPC " + (.link_click_cpc | . * 100 | round / 100 | tostring) + " above threshold"
                    else "CTR " + (.link_click_ctr | . * 100 | round / 100 | tostring) + "% below threshold" end)}
                else {action: "maintain", reason: "within target range"} end)
              elif $t_cpc > 0 then (
                if .link_click_cpc != null and .link_click_cpc < ($t_cpc * 0.8) then {action: "scale", reason: ("CPC " + (.link_click_cpc | . * 100 | round / 100 | tostring) + " below target")}
                elif .link_click_cpc != null and .link_click_cpc > ($t_cpc * 1.2) then {action: "reduce", reason: ("CPC " + (.link_click_cpc | . * 100 | round / 100 | tostring) + " above threshold")}
                else {action: "maintain", reason: "within target range"} end)
              elif $t_ctr > 0 then (
                if .link_click_ctr > ($t_ctr * 1.2) then
                  {action: "scale", reason: ("CTR " + (.link_click_ctr | . * 100 | round / 100 | tostring) + "% above target")}
                elif .link_click_ctr < ($t_ctr * 0.8) then
                  {action: "reduce", reason: ("CTR " + (.link_click_ctr | . * 100 | round / 100 | tostring) + "% below threshold")}
                else {action: "maintain", reason: "within target range"} end)
              else {action: "maintain", reason: "no targets set"} end
            )

            elif $obj == "OUTCOME_AWARENESS" then (
              ($obj_targets.cpm // 0) as $t_cpm |
              if .impressions == 0 then
                {action: "pause", reason: ("zero impressions with spend " + (.spend | tostring))}
              elif $t_cpm > 0 then (
                if .cpm < ($t_cpm * 0.8) then {action: "scale", reason: ("CPM " + (.cpm | . * 100 | round / 100 | tostring) + " below target")}
                elif .cpm > ($t_cpm * 1.2) then {action: "reduce", reason: ("CPM " + (.cpm | . * 100 | round / 100 | tostring) + " above threshold")}
                else {action: "maintain", reason: "within target range"} end)
              else {action: "maintain", reason: "no targets set"} end
            )

            elif $obj == "OUTCOME_ENGAGEMENT" then (
              ($obj_targets.cpe // 0) as $t_cpe |
              if .post_engagement == 0 then
                {action: "pause", reason: ("zero engagement with spend " + (.spend | tostring))}
              elif $t_cpe > 0 then (
                if .cpe != null and .cpe < ($t_cpe * 0.8) then {action: "scale", reason: ("CPE " + (.cpe | . * 100 | round / 100 | tostring) + " below target")}
                elif .cpe != null and .cpe > ($t_cpe * 1.2) then {action: "reduce", reason: ("CPE " + (.cpe | . * 100 | round / 100 | tostring) + " above threshold")}
                else {action: "maintain", reason: "within target range"} end)
              else {action: "maintain", reason: "no targets set"} end
            )

            elif $obj == "OUTCOME_LEADS" then (
              ($obj_targets.cpl // 0) as $t_cpl |
              if .lead == 0 then
                {action: "pause", reason: ("zero leads with spend " + (.spend | tostring))}
              elif $t_cpl > 0 then (
                if .cpl != null and .cpl < ($t_cpl * 0.8) then {action: "scale", reason: ("CPL " + (.cpl | . * 100 | round / 100 | tostring) + " below target")}
                elif .cpl != null and .cpl > ($t_cpl * 1.2) then {action: "reduce", reason: ("CPL " + (.cpl | . * 100 | round / 100 | tostring) + " above threshold")}
                else {action: "maintain", reason: "within target range"} end)
              else {action: "maintain", reason: "no targets set"} end
            )

            elif $obj == "OUTCOME_APP_PROMOTION" then (
              ($obj_targets.cpi // 0) as $t_cpi |
              if .app_install == 0 then
                {action: "pause", reason: ("zero installs with spend " + (.spend | tostring))}
              elif $t_cpi > 0 then (
                if .cpi != null and .cpi < ($t_cpi * 0.8) then {action: "scale", reason: ("CPI " + (.cpi | . * 100 | round / 100 | tostring) + " below target")}
                elif .cpi != null and .cpi > ($t_cpi * 1.2) then {action: "reduce", reason: ("CPI " + (.cpi | . * 100 | round / 100 | tostring) + " above threshold")}
                else {action: "maintain", reason: "within target range"} end)
              else {action: "maintain", reason: "no targets set"} end
            )

            else {action: "maintain", reason: "unknown objective"} end
          ) |

          # Keep objective-appropriate fields
          {adset_name, campaign_name, objective, action, reason, spend,
           frequency: (.frequency | . * 100 | round / 100)} +
          if $obj == "OUTCOME_SALES" then
            {roas: (.roas | . * 100 | round / 100), cpa: (if .cpa then (.cpa | . * 100 | round / 100) else null end), purchases}
          elif $obj == "OUTCOME_TRAFFIC" then
            {cpc: (if .link_click_cpc then (.link_click_cpc | . * 100 | round / 100) else null end), ctr: (.link_click_ctr | . * 100 | round / 100), link_clicks}
          elif $obj == "OUTCOME_AWARENESS" then
            {cpm: (.cpm | . * 100 | round / 100), reach}
          elif $obj == "OUTCOME_ENGAGEMENT" then
            {cpe: (if .cpe then (.cpe | . * 100 | round / 100) else null end), post_engagement}
          elif $obj == "OUTCOME_LEADS" then
            {cpl: (if .cpl then (.cpl | . * 100 | round / 100) else null end), lead}
          elif $obj == "OUTCOME_APP_PROMOTION" then
            {cpi: (if .cpi then (.cpi | . * 100 | round / 100) else null end), app_install}
          else {} end
        ) |

        # Split by action type
        {($obj): {
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
        }}
      ] | add // {}
    )' "$RUN_DIR/adsets-summary.json" > "$RUN_DIR/budget-actions.json"
  echo "  budget-actions.json"
fi

# ─── 3. funnel.json ──────────────────────────────────────────────────────────
if [[ -f "$RUN_DIR/campaigns-summary.json" ]]; then
  jq '
    ([.[].objective] | unique | sort) as $objectives |

    {objectives_present: $objectives} + (
      [$objectives[] as $obj |
        [.[] | select(.objective == $obj)] |

        {($obj): (
          if $obj == "OUTCOME_SALES" then
            # Full 7-stage purchase funnel
            {
              type: "funnel",
              stages: ["impressions", "link_clicks", "landing_page_views", "view_content", "add_to_cart", "initiate_checkout", "purchases"],
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
                add_to_cart_rate: (if .landing_page_views > 0 then (.add_to_cart / .landing_page_views * 100 | . * 100 | round / 100) else null end),
                cart_to_checkout: (if .add_to_cart > 0 then (.initiate_checkout / .add_to_cart * 100 | . * 100 | round / 100) else null end),
                checkout_to_purchase: (if .initiate_checkout > 0 then (.purchases / .initiate_checkout * 100 | . * 100 | round / 100) else null end)
              },
              engagement: {
                view_content: .view_content,
                browse_depth: (if .landing_page_views > 0 then (.view_content / .landing_page_views | . * 100 | round / 100) else null end)
              }
            } | . + {
              bottleneck: (
                [
                  {stage: "TOFU_click", label: "impression \u2192 click", rate: .rates.click_rate, expected: 3.0},
                  {stage: "TOFU_landing", label: "click \u2192 landing page", rate: .rates.landing_rate, expected: 70.0},
                  {stage: "MOFU_landing_to_cart", label: "landing page \u2192 add to cart", rate: .rates.add_to_cart_rate, expected: 8.0},
                  {stage: "BOFU_cart_to_checkout", label: "add to cart \u2192 checkout", rate: .rates.cart_to_checkout, expected: 50.0},
                  {stage: "BOFU_checkout_to_purchase", label: "checkout \u2192 purchase", rate: .rates.checkout_to_purchase, expected: 60.0}
                ] | map(select(.rate != null)) |
                map(. + {gap: (if .expected > 0 then ((.expected - .rate) / .expected) else 0 end)}) |
                sort_by(-.gap) | .[0] // null |
                if . then {stage, label, rate} else null end
              )
            }

          elif $obj == "OUTCOME_TRAFFIC" then
            # 3-stage click funnel
            {
              type: "funnel",
              stages: ["impressions", "link_clicks", "landing_page_views"],
              impressions: (map(.impressions) | add // 0),
              link_clicks: (map(.link_clicks) | add // 0),
              landing_page_views: (map(.landing_page_views) | add // 0)
            } | . + {
              rates: {
                click_rate: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else null end),
                landing_rate: (if .link_clicks > 0 then (.landing_page_views / .link_clicks * 100 | . * 100 | round / 100) else null end)
              }
            } | . + {
              bottleneck: (
                [
                  {stage: "click_rate", label: "impression \u2192 click", rate: .rates.click_rate, expected: 1.5},
                  {stage: "landing_rate", label: "click \u2192 landing page", rate: .rates.landing_rate, expected: 70.0}
                ] | map(select(.rate != null)) |
                map(. + {gap: (if .expected > 0 then ((.expected - .rate) / .expected) else 0 end)}) |
                sort_by(-.gap) | .[0] // null |
                if . then {stage, label, rate} else null end
              )
            }

          elif $obj == "OUTCOME_AWARENESS" then
            # Reach efficiency (no conversion funnel)
            (map(.impressions) | add // 0) as $imp |
            (map(.reach) | add // 0) as $rch |
            (map(.spend) | add // 0) as $spend |
            {
              type: "reach_efficiency",
              total_reach: $rch,
              total_impressions: $imp,
              total_spend: $spend,
              cpm: (if $imp > 0 then ($spend / $imp * 1000 | . * 100 | round / 100) else null end),
              avg_frequency: (if $rch > 0 then ($imp / $rch | . * 100 | round / 100) else null end),
              reach_rate: (if $imp > 0 then ($rch / $imp * 100 | . * 100 | round / 100) else null end),
              note: "No conversion funnel for awareness \u2014 showing reach efficiency metrics"
            }

          elif $obj == "OUTCOME_ENGAGEMENT" then
            # 3-stage engagement funnel
            {
              type: "funnel",
              stages: ["impressions", "post_engagement", "page_engagement"],
              impressions: (map(.impressions) | add // 0),
              post_engagement: (map(.post_engagement) | add // 0),
              page_engagement: (map(.page_engagement) | add // 0)
            } | . + {
              rates: {
                engagement_rate: (if .impressions > 0 then (.post_engagement / .impressions * 100 | . * 100 | round / 100) else null end),
                deep_engagement_rate: (if .post_engagement > 0 then (.page_engagement / .post_engagement * 100 | . * 100 | round / 100) else null end)
              }
            } | . + {
              bottleneck: (
                [
                  {stage: "engagement_rate", label: "impression \u2192 engagement", rate: .rates.engagement_rate, expected: 2.0},
                  {stage: "deep_engagement_rate", label: "engagement \u2192 page engagement", rate: .rates.deep_engagement_rate, expected: 15.0}
                ] | map(select(.rate != null)) |
                map(. + {gap: (if .expected > 0 then ((.expected - .rate) / .expected) else 0 end)}) |
                sort_by(-.gap) | .[0] // null |
                if . then {stage, label, rate} else null end
              )
            }

          elif $obj == "OUTCOME_LEADS" then
            # 4-stage lead funnel
            {
              type: "funnel",
              stages: ["impressions", "link_clicks", "landing_page_views", "leads"],
              impressions: (map(.impressions) | add // 0),
              link_clicks: (map(.link_clicks) | add // 0),
              landing_page_views: (map(.landing_page_views) | add // 0),
              leads: (map(.lead) | add // 0)
            } | . + {
              rates: {
                click_rate: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else null end),
                landing_rate: (if .link_clicks > 0 then (.landing_page_views / .link_clicks * 100 | . * 100 | round / 100) else null end),
                lead_conversion_rate: (if .landing_page_views > 0 then (.leads / .landing_page_views * 100 | . * 100 | round / 100) else null end)
              }
            } | . + {
              bottleneck: (
                [
                  {stage: "click_rate", label: "impression \u2192 click", rate: .rates.click_rate, expected: 2.0},
                  {stage: "landing_rate", label: "click \u2192 landing page", rate: .rates.landing_rate, expected: 60.0},
                  {stage: "lead_conversion", label: "landing page \u2192 lead", rate: .rates.lead_conversion_rate, expected: 5.0}
                ] | map(select(.rate != null)) |
                map(. + {gap: (if .expected > 0 then ((.expected - .rate) / .expected) else 0 end)}) |
                sort_by(-.gap) | .[0] // null |
                if . then {stage, label, rate} else null end
              )
            }

          elif $obj == "OUTCOME_APP_PROMOTION" then
            # 3-stage install funnel
            {
              type: "funnel",
              stages: ["impressions", "link_clicks", "app_installs"],
              impressions: (map(.impressions) | add // 0),
              link_clicks: (map(.link_clicks) | add // 0),
              app_installs: (map(.app_install) | add // 0)
            } | . + {
              rates: {
                click_rate: (if .impressions > 0 then (.link_clicks / .impressions * 100 | . * 100 | round / 100) else null end),
                install_rate: (if .link_clicks > 0 then (.app_installs / .link_clicks * 100 | . * 100 | round / 100) else null end)
              }
            } | . + {
              bottleneck: (
                [
                  {stage: "click_rate", label: "impression \u2192 click", rate: .rates.click_rate, expected: 1.5},
                  {stage: "install_rate", label: "click \u2192 install", rate: .rates.install_rate, expected: 5.0}
                ] | map(select(.rate != null)) |
                map(. + {gap: (if .expected > 0 then ((.expected - .rate) / .expected) else 0 end)}) |
                sort_by(-.gap) | .[0] // null |
                if . then {stage, label, rate} else null end
              )
            }

          else
            {type: "unknown", note: ("No funnel defined for objective " + $obj)}
          end
        )}
      ] | add // {}
    )' "$RUN_DIR/campaigns-summary.json" > "$RUN_DIR/funnel.json"
  echo "  funnel.json"
fi

# ─── 4. trends.json ──────────────────────────────────────────────────────────
if [[ -d "$RUN_DIR/_recent" && -f "$RUN_DIR/_recent/campaigns-summary.json" && -f "$RUN_DIR/campaigns-summary.json" ]]; then
  jq --slurpfile recent "$RUN_DIR/_recent/campaigns-summary.json" '

    ([.[].objective] | unique | sort) as $objectives |
    # Build lookup of recent data by campaign_id
    ($recent[0] | INDEX(.[]; .campaign_id)) as $recent_idx |

    # Period date range
    (if length > 0 then .[0].date_start else null end) as $period_start |
    (if length > 0 then .[0].date_stop else null end) as $period_stop |
    ($recent[0] | if length > 0 then .[0].date_start else null end) as $recent_start |
    ($recent[0] | if length > 0 then .[0].date_stop else null end) as $recent_stop |

    {
      available: true,
      period: {start: $period_start, stop: $period_stop},
      recent: {start: $recent_start, stop: $recent_stop},
      objectives_present: $objectives,
      campaigns: [
        .[] | select(.campaign_id != null) |
        . as $period |
        ($recent_idx[.campaign_id] // null) as $r |
        if $r then
          {
            campaign_name: .campaign_name,
            campaign_id: .campaign_id,
            objective: .objective,
            period_spend: .spend,
            recent_spend: $r.spend,
            frequency_delta_pct: (
              if .frequency > 0 and $r.frequency != null then
                (($r.frequency - .frequency) / .frequency * 100 | round) else null end)
          } +
          # Objective-appropriate deltas
          if .objective == "OUTCOME_SALES" then {
            period_cpa: .cpa,
            recent_cpa: $r.cpa,
            period_roas: (.roas | . * 100 | round / 100),
            recent_roas: ($r.roas | . * 100 | round / 100),
            cpa_delta_pct: (if .cpa != null and .cpa > 0 and $r.cpa != null then
              (($r.cpa - .cpa) / .cpa * 100 | round) else null end),
            roas_delta_pct: (if .roas > 0 and $r.roas != null then
              (($r.roas - .roas) / .roas * 100 | round) else null end)
          }
          elif .objective == "OUTCOME_TRAFFIC" then {
            period_cpc: (if .link_click_cpc then (.link_click_cpc | . * 100 | round / 100) else null end),
            recent_cpc: (if $r.link_click_cpc then ($r.link_click_cpc | . * 100 | round / 100) else null end),
            period_ctr: (.link_click_ctr | . * 100 | round / 100),
            recent_ctr: ($r.link_click_ctr | . * 100 | round / 100),
            cpc_delta_pct: (if .link_click_cpc != null and .link_click_cpc > 0 and $r.link_click_cpc != null then
              (($r.link_click_cpc - .link_click_cpc) / .link_click_cpc * 100 | round) else null end),
            ctr_delta_pct: (if .link_click_ctr > 0 and $r.link_click_ctr != null then
              (($r.link_click_ctr - .link_click_ctr) / .link_click_ctr * 100 | round) else null end)
          }
          elif .objective == "OUTCOME_AWARENESS" then {
            period_cpm: (.cpm | . * 100 | round / 100),
            recent_cpm: ($r.cpm | . * 100 | round / 100),
            cpm_delta_pct: (if .cpm > 0 and $r.cpm != null then
              (($r.cpm - .cpm) / .cpm * 100 | round) else null end)
          }
          elif .objective == "OUTCOME_ENGAGEMENT" then {
            period_cpe: (if .cpe then (.cpe | . * 100 | round / 100) else null end),
            recent_cpe: (if $r.cpe then ($r.cpe | . * 100 | round / 100) else null end),
            cpe_delta_pct: (if .cpe != null and .cpe > 0 and $r.cpe != null then
              (($r.cpe - .cpe) / .cpe * 100 | round) else null end)
          }
          elif .objective == "OUTCOME_LEADS" then {
            period_cpl: (if .cpl then (.cpl | . * 100 | round / 100) else null end),
            recent_cpl: (if $r.cpl then ($r.cpl | . * 100 | round / 100) else null end),
            cpl_delta_pct: (if .cpl != null and .cpl > 0 and $r.cpl != null then
              (($r.cpl - .cpl) / .cpl * 100 | round) else null end)
          }
          elif .objective == "OUTCOME_APP_PROMOTION" then {
            period_cpi: (if .cpi then (.cpi | . * 100 | round / 100) else null end),
            recent_cpi: (if $r.cpi then ($r.cpi | . * 100 | round / 100) else null end),
            cpi_delta_pct: (if .cpi != null and .cpi > 0 and $r.cpi != null then
              (($r.cpi - .cpi) / .cpi * 100 | round) else null end)
          }
          else {} end |

          # Flags: >15% deterioration on primary KPI
          . + {flags: ([
            (if .objective == "OUTCOME_SALES" then
              (if .roas_delta_pct != null and .roas_delta_pct < -15 then "roas_declining" else null end),
              (if .cpa_delta_pct != null and .cpa_delta_pct > 15 then "cpa_rising" else null end)
            elif .objective == "OUTCOME_TRAFFIC" then
              (if .cpc_delta_pct != null and .cpc_delta_pct > 15 then "cpc_rising" else null end),
              (if .ctr_delta_pct != null and .ctr_delta_pct < -15 then "ctr_declining" else null end)
            elif .objective == "OUTCOME_AWARENESS" then
              (if .cpm_delta_pct != null and .cpm_delta_pct > 15 then "cpm_rising" else null end)
            elif .objective == "OUTCOME_ENGAGEMENT" then
              (if .cpe_delta_pct != null and .cpe_delta_pct > 15 then "cpe_rising" else null end)
            elif .objective == "OUTCOME_LEADS" then
              (if .cpl_delta_pct != null and .cpl_delta_pct > 15 then "cpl_rising" else null end)
            elif .objective == "OUTCOME_APP_PROMOTION" then
              (if .cpi_delta_pct != null and .cpi_delta_pct > 15 then "cpi_rising" else null end)
            else null end),
            (if .frequency_delta_pct != null and .frequency_delta_pct > 20 then "frequency_rising" else null end)
          ] | map(select(. != null)))}
        else empty end
      ]
    } | . + {
      flagged: [.campaigns[] | select((.flags | length) > 0) |
        {campaign_name, objective, flags}]
    }' "$RUN_DIR/campaigns-summary.json" > "$RUN_DIR/trends.json"
  echo "  trends.json"
else
  echo '{"available": false, "reason": "no recent window data"}' > "$RUN_DIR/trends.json"
  echo "  trends.json (no recent data)"
fi

# ─── 5. creative-analysis.json + 6. creative-media.json ──────────────────────
# Both use obj_meta for ranking. creative-analysis outputs agent-facing analysis;
# creative-media outputs ad_id + URLs for analyze-creatives.sh.
if [[ -f "$RUN_DIR/ads-summary.json" ]]; then
  # Ensure creatives file exists for URL lookup (empty array fallback)
  CREATIVES_FILE="$RUN_DIR/_raw/creatives.json"
  if [[ ! -f "$CREATIVES_FILE" ]]; then
    echo '[]' > "$RUN_DIR/_creatives_empty.json"
    CREATIVES_FILE="$RUN_DIR/_creatives_empty.json"
  fi

  jq --slurpfile cfg "$CONFIG" --argjson top_n "$TOP_N" \
     --argjson bottom_n "$BOTTOM_N" --argjson zero_n "$ZERO_N" \
     --slurpfile creatives "$CREATIVES_FILE" '

    # Data-driven objective metadata — single source of truth for ranking
    def obj_meta($obj):
      if $obj == "OUTCOME_SALES" then {conv: "purchases", sort: "roas", dir: "desc", zero_label: "zero_purchase"}
      elif $obj == "OUTCOME_TRAFFIC" then {conv: "link_clicks", sort: "link_click_ctr", dir: "desc", zero_label: "zero_clicks"}
      elif $obj == "OUTCOME_AWARENESS" then {conv: "impressions", sort: "cpm", dir: "asc", zero_label: "zero_impressions"}
      elif $obj == "OUTCOME_ENGAGEMENT" then {conv: "post_engagement", sort: "cpe", dir: "asc", zero_label: "zero_engagement"}
      elif $obj == "OUTCOME_LEADS" then {conv: "lead", sort: "cpl", dir: "asc", zero_label: "zero_leads"}
      elif $obj == "OUTCOME_APP_PROMOTION" then {conv: "app_install", sort: "cpi", dir: "asc", zero_label: "zero_installs"}
      else {conv: "purchases", sort: "spend", dir: "desc", zero_label: "zero_conversion"} end;

    # Shared ranking computation
    def rank_ads($obj; $top_n; $bottom_n; $zero_n):
      obj_meta($obj) as $m |
      (map(select(.[$m.conv] > 0)) |
        if $m.dir == "desc" then sort_by(-(.[$m.sort] // 0)) else sort_by(.[$m.sort] // 0) end
      ) as $with_conv |
      (map(select(.[$m.conv] == 0)) | sort_by(-.spend)) as $zero_conv |
      ($with_conv | length) as $total |
      ([$top_n, ([1, ($total / 2 | floor)] | max)] | min) as $win_n |
      ([$bottom_n, ($total - $win_n)] | min | if . < 0 then 0 else . end) as $lose_n |
      {with_conv: $with_conv, zero_conv: $zero_conv, win_n: $win_n, lose_n: $lose_n, total_ads: length};

    # Shared ad formatting (rounded KPIs)
    def format_ad:
      {
        ad_name, campaign_name, creative_body, creative_title, spend,
        roas: (if .roas then (.roas | . * 100 | round / 100) else 0 end),
        cpa: (if .cpa then (.cpa | . * 100 | round / 100) else null end),
        cpc: (.cpc | . * 100 | round / 100),
        ctr: (.ctr | . * 100 | round / 100),
        cpe: (if .cpe then (.cpe | . * 100 | round / 100) else null end),
        cpl: (if .cpl then (.cpl | . * 100 | round / 100) else null end),
        cpi: (if .cpi then (.cpi | . * 100 | round / 100) else null end),
        purchases, post_engagement, lead, app_install
      };

    ($cfg[0].targets.global.min_spend // 0) as $min_spend |
    ([.[].objective] | unique | sort) as $objectives |

    # URL lookup from raw creatives
    ($creatives[0] | (.data // .) | if type == "array" and length > 0 then
      (INDEX(.[]; .id) | map_values({
        creative_image_url: (.creative_image_url // ""),
        creative_thumbnail_url: (.creative_thumbnail_url // "")
      }) else {} end)
    else {} end) as $url_lookup |

    # creative-analysis.json content
    ({objectives_present: $objectives} + (
      [$objectives[] as $obj |
        [.[] | select(.objective == $obj and .spend >= $min_spend)] |
        rank_ads($obj; $top_n; $bottom_n; $zero_n) as $r |
        {($obj): {
          overview: {
            total_ads: $r.total_ads,
            with_conversions: ($r.with_conv | length),
            zero_conversion_count: ($r.zero_conv | length),
            zero_conversion_total_spend: ($r.zero_conv | map(.spend) | add // 0)
          },
          winners: [$r.with_conv[:$r.win_n][] | format_ad],
          losers: [if $r.lose_n > 0 then $r.with_conv[-$r.lose_n:][] else empty end | format_ad],
          zero_conversion: [$r.zero_conv[:$zero_n][] | {ad_name, campaign_name, creative_body, creative_title, spend}]
        }}
      ] | add // {}
    )) as $analysis |

    # creative-media.json content
    ([$objectives[] as $obj |
      [.[] | select(.objective == $obj and .spend >= $min_spend)] |
      rank_ads($obj; $top_n; $bottom_n; $zero_n) as $r |
      ($r.with_conv[:$r.win_n][] | . + {rank: "winner"}),
      (if $r.lose_n > 0 then $r.with_conv[-$r.lose_n:][] else empty end | . + {rank: "loser"}),
      ($r.zero_conv[:$zero_n][] | . + {rank: "zero_conversion"})
    ] | map(
      (.ad_id | tostring) as $aid |
      {
        ad_id: .ad_id,
        ad_name: .ad_name,
        objective: .objective,
        rank: .rank,
        roas: (if .roas then (.roas | . * 100 | round / 100) else 0 end),
        cpa: (if .cpa then (.cpa | . * 100 | round / 100) else null end),
        spend: .spend,
        creative_image_url: ($url_lookup[($aid)] // {}).creative_image_url // "",
        creative_thumbnail_url: ($url_lookup[($aid)] // {}).creative_thumbnail_url // ""
      }
    )) as $media |

    {analysis: $analysis, media: $media}
  ' "$RUN_DIR/ads-summary.json" > "$RUN_DIR/_creative_combined.json"

  # Split combined output into two files
  jq '.analysis' "$RUN_DIR/_creative_combined.json" > "$RUN_DIR/creative-analysis.json"
  jq '.media' "$RUN_DIR/_creative_combined.json" > "$RUN_DIR/creative-media.json"
  rm -f "$RUN_DIR/_creative_combined.json" "$RUN_DIR/_creatives_empty.json"
  echo "  creative-analysis.json"
  echo "  creative-media.json"
else
  echo '[]' > "$RUN_DIR/creative-media.json"
  echo "  creative-media.json (no creative data available)"
fi

# Report which output files were generated vs missing
EXPECTED_FILES=(account-health.json budget-actions.json funnel.json trends.json creative-analysis.json creative-media.json)
MISSING=()
for f in "${EXPECTED_FILES[@]}"; do
  if [[ ! -f "$RUN_DIR/$f" ]]; then
    MISSING+=("$f")
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "  WARNING: Missing output files: ${MISSING[*]}" >&2
fi

echo "Analysis preparation complete (${#EXPECTED_FILES[@]} expected, $((${#EXPECTED_FILES[@]} - ${#MISSING[@]})) generated)."
