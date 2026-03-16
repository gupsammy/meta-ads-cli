#!/bin/bash
set -e

# Pull Meta Ads data via the meta-ads CLI.
# Stores raw JSON + compressed summaries in dated directories.
#
# Configuration (override via environment variables):
#   META_ADS_ACCOUNT_ID  — Meta ad account ID (e.g., act_123456789)
#   META_ADS_CLI         — Path to meta-ads CLI binary (default: "meta-ads")
#   META_ADS_DATA_DIR    — Data storage directory (default: /tmp/meta-ads-intel)
#
# Usage:
#   pull-data.sh [date-preset]        Pull today + aggregated period data
#   pull-data.sh --seed N             Backfill N days of historical daily snapshots
#
# Date presets: last_7d, last_14d, last_30d, last_90d, this_month, last_month

ACCOUNT_ID="${META_ADS_ACCOUNT_ID:?Set META_ADS_ACCOUNT_ID environment variable (e.g., act_123456789)}"
CLI="${META_ADS_CLI:-meta-ads}"
DATA_DIR="${META_ADS_DATA_DIR:-/tmp/meta-ads-intel}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Portable date: tries GNU coreutils first, falls back to BSD (macOS)
portable_date_ago() {
  local days=$1
  date -d "$days days ago" '+%Y-%m-%d' 2>/dev/null || date -v-${days}d '+%Y-%m-%d'
}

# Warn when results hit the --limit cap (possible silent truncation)
warn_if_truncated() {
  local file="$1" label="$2" limit="${3:-500}"
  local count
  count=$(jq '.data | length' "$file" 2>/dev/null || echo 0)
  if [[ "$count" -ge "$limit" ]]; then
    echo "    WARNING: $label returned $count items (limit $limit reached) — results may be truncated" >&2
  fi
}

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed. Install with: brew install jq" >&2
  exit 1
fi

# Parse arguments
SEED_DAYS=0
DATE_PRESET="last_14d"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seed)
      SEED_DAYS="$2"
      shift 2
      ;;
    *)
      DATE_PRESET="$1"
      shift
      ;;
  esac
done

# Helper: pull one day's data into a dated directory
pull_day() {
  local since="$1"
  local until="$2"
  local day_dir="$DATA_DIR/$since"
  mkdir -p "$day_dir"

  echo "  Pulling $since..."

  # Campaign-level insights (daily)
  "$CLI" insights get \
    --account-id "$ACCOUNT_ID" \
    --since "$since" --until "$until" \
    --level campaign \
    --time-increment 1 \
    --limit 500 \
    -o json > "$day_dir/campaigns.json"
  warn_if_truncated "$day_dir/campaigns.json" "campaigns"

  # Adset-level insights (daily)
  "$CLI" insights get \
    --account-id "$ACCOUNT_ID" \
    --since "$since" --until "$until" \
    --level adset \
    --time-increment 1 \
    --limit 500 \
    -o json > "$day_dir/adsets.json"
  warn_if_truncated "$day_dir/adsets.json" "adsets"

  # Ad-level insights (daily)
  "$CLI" insights get \
    --account-id "$ACCOUNT_ID" \
    --since "$since" --until "$until" \
    --level ad \
    --time-increment 1 \
    --limit 500 \
    -o json > "$day_dir/ads.json"
  warn_if_truncated "$day_dir/ads.json" "ads"

  # Ad creatives (not date-scoped — pull once, reuse)
  if [[ ! -f "$DATA_DIR/creatives-master.json" ]]; then
    "$CLI" ads list \
      --account-id "$ACCOUNT_ID" \
      --limit 500 \
      -o json > "$DATA_DIR/creatives-master.json"
    warn_if_truncated "$DATA_DIR/creatives-master.json" "ad creatives"
  fi
  cp "$DATA_DIR/creatives-master.json" "$day_dir/creatives.json"

  # Account info (small, same for all days)
  if [[ ! -f "$DATA_DIR/account-master.json" ]]; then
    "$CLI" accounts get \
      --account-id "$ACCOUNT_ID" \
      -o json > "$DATA_DIR/account-master.json"
  fi
  cp "$DATA_DIR/account-master.json" "$day_dir/account.json"

  # Run summarization for this day
  bash "$SCRIPT_DIR/summarize-data.sh" "$day_dir"

  local lines_c lines_a lines_ad
  lines_c=$(wc -l < "$day_dir/campaigns.json" | tr -d ' ')
  lines_a=$(wc -l < "$day_dir/adsets.json" | tr -d ' ')
  lines_ad=$(wc -l < "$day_dir/ads.json" | tr -d ' ')
  echo "    campaigns=$lines_c adsets=$lines_a ads=$lines_ad lines"
}

# Update manifest.json and latest.json
update_manifest() {
  local dates=()
  for d in "$DATA_DIR"/????-??-??; do
    if [[ -d "$d" ]]; then
      dates+=("$(basename "$d")")
    fi
  done

  IFS=$'\n' sorted=($(sort <<<"${dates[*]}")); unset IFS

  printf '%s\n' "${sorted[@]}" | jq -R . | jq -s '{dates: ., count: length}' > "$DATA_DIR/manifest.json"

  local count=${#sorted[@]}
  if [[ $count -gt 0 ]]; then
    local last_idx=$((count - 1))
    echo "{\"latest\": \"${sorted[$last_idx]}\"}" | jq . > "$DATA_DIR/latest.json"
  fi

  echo "Manifest updated: ${#sorted[@]} dates available"
}

mkdir -p "$DATA_DIR"

if [[ "$SEED_DAYS" -gt 0 ]]; then
  echo "Seeding $SEED_DAYS days of data for $ACCOUNT_ID..."

  for i in $(seq "$SEED_DAYS" -1 1); do
    day_since=$(portable_date_ago "$i")
    day_until="$day_since"
    pull_day "$day_since" "$day_until"
  done

  today=$(date '+%Y-%m-%d')
  pull_day "$today" "$today"

  update_manifest
  echo "Seed complete. $((SEED_DAYS + 1)) days saved to $DATA_DIR/"

else
  today=$(date '+%Y-%m-%d')
  echo "Pulling Meta Ads data for $ACCOUNT_ID ($DATE_PRESET)..."

  # Pull today's daily snapshot
  pull_day "$today" "$today"

  # Pull aggregated period data into _period subdirectory
  period_dir="$DATA_DIR/_period"
  mkdir -p "$period_dir"

  "$CLI" insights get \
    --account-id "$ACCOUNT_ID" \
    --date-preset "$DATE_PRESET" \
    --level campaign \
    --limit 500 \
    -o json > "$period_dir/campaigns.json"
  warn_if_truncated "$period_dir/campaigns.json" "period campaigns"

  "$CLI" insights get \
    --account-id "$ACCOUNT_ID" \
    --date-preset "$DATE_PRESET" \
    --level adset \
    --limit 500 \
    -o json > "$period_dir/adsets.json"
  warn_if_truncated "$period_dir/adsets.json" "period adsets"

  "$CLI" insights get \
    --account-id "$ACCOUNT_ID" \
    --date-preset "$DATE_PRESET" \
    --level ad \
    --limit 500 \
    -o json > "$period_dir/ads.json"
  warn_if_truncated "$period_dir/ads.json" "period ads"

  cp "$DATA_DIR/creatives-master.json" "$period_dir/creatives.json" 2>/dev/null || true
  cp "$DATA_DIR/account-master.json" "$period_dir/account.json" 2>/dev/null || true

  # Summarize the period data
  bash "$SCRIPT_DIR/summarize-data.sh" "$period_dir"

  # Pull a recent window (last_7d) for period comparison
  # Skip if user already requested last_7d (would be identical)
  if [[ "$DATE_PRESET" != "last_7d" ]]; then
    recent_dir="$DATA_DIR/_recent"
    mkdir -p "$recent_dir"
    echo "  Pulling recent window (last_7d) for comparison..."

    "$CLI" insights get \
      --account-id "$ACCOUNT_ID" \
      --date-preset last_7d \
      --level campaign \
      --limit 500 \
      -o json > "$recent_dir/campaigns.json"
    warn_if_truncated "$recent_dir/campaigns.json" "recent campaigns"

    "$CLI" insights get \
      --account-id "$ACCOUNT_ID" \
      --date-preset last_7d \
      --level adset \
      --limit 500 \
      -o json > "$recent_dir/adsets.json"
    warn_if_truncated "$recent_dir/adsets.json" "recent adsets"

    "$CLI" insights get \
      --account-id "$ACCOUNT_ID" \
      --date-preset last_7d \
      --level ad \
      --limit 500 \
      -o json > "$recent_dir/ads.json"
    warn_if_truncated "$recent_dir/ads.json" "recent ads"

    cp "$DATA_DIR/creatives-master.json" "$recent_dir/creatives.json" 2>/dev/null || true
    bash "$SCRIPT_DIR/summarize-data.sh" "$recent_dir"
  fi

  update_manifest
  echo "Data pull complete. Files saved to $DATA_DIR/"
fi
