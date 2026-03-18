#!/bin/bash
set -e

# Extract current CPA and ROAS from account insights for onboarding defaults.
# Outputs a compact JSON with current performance metrics.
#
# Usage: compute-defaults.sh <account_id>
# Requires: meta-ads CLI, jq

ACCOUNT_ID="${1:?Usage: compute-defaults.sh <account_id>}"
CLI="${META_ADS_CLI:-meta-ads}"

if ! command -v jq &>/dev/null; then
  echo '{"error": "jq is required but not installed"}' >&2
  exit 1
fi

# Pull account-level insights for last 14 days
RAW=$("$CLI" insights get \
  --account-id "$ACCOUNT_ID" \
  --date-preset last_14d \
  --level account \
  -o json)

# Extract key metrics via jq — handles Meta's nested actions/action_values arrays
echo "$RAW" | jq '{
  spend: ((.data // .)[0].spend // "0" | tonumber),
  purchases: ((.data // .)[0].actions // [] | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
  revenue: ((.data // .)[0].action_values // [] | map(select(.action_type == "purchase")) | .[0].value // "0" | tonumber),
  roas: ((.data // .)[0].purchase_roas // [] | map(select(.action_type == "omni_purchase")) | .[0].value // "0" | tonumber)
} | . + {
  current_cpa: (if .purchases > 0 then (.spend / .purchases | . * 100 | round / 100) else null end),
  current_roas: (.roas | . * 100 | round / 100)
}'
