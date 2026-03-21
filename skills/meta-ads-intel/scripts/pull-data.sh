#!/bin/bash
set -euo pipefail
umask 077

# Pull Meta Ads data via the meta-ads CLI.
# Stores raw JSON in _raw/, summarizes, then runs prepare-analysis.sh
# to produce 6 agent-ready analysis files.
#
# Account ID resolution (first match wins):
#   1. META_ADS_ACCOUNT_ID env var
#   2. ~/.meta-ads-intel/config.json → .account_id
#   3. ~/.config/meta-ads-cli/config.json → .defaults.account_id
#
# Configuration (override via environment variables):
#   META_ADS_CLI         — Path to meta-ads CLI binary (default: "meta-ads")
#   META_ADS_DATA_DIR    — Data storage directory (default: ~/.meta-ads-intel/data)
#
# Usage:
#   pull-data.sh [date-preset]        Pull data into timestamped run directory
#
# Date presets: last_7d, last_14d, last_30d, last_90d, this_month, last_month

# ─── Account ID resolution ────────────────────────────────────────────────────
SKILL_CONFIG="$HOME/.meta-ads-intel/config.json"
CLI_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/meta-ads-cli/config.json"

if [[ -n "${META_ADS_ACCOUNT_ID:-}" ]]; then
  ACCOUNT_ID="$META_ADS_ACCOUNT_ID"
  ACCOUNT_SOURCE="env"
elif [[ -f "$SKILL_CONFIG" ]] && jq -e '.account_id' "$SKILL_CONFIG" &>/dev/null; then
  ACCOUNT_ID=$(jq -r '.account_id' "$SKILL_CONFIG")
  ACCOUNT_SOURCE="skill config"
elif [[ -f "$CLI_CONFIG" ]] && jq -e '.defaults.account_id' "$CLI_CONFIG" &>/dev/null; then
  ACCOUNT_ID=$(jq -r '.defaults.account_id' "$CLI_CONFIG")
  ACCOUNT_SOURCE="CLI config"
else
  echo "Error: No account ID found." >&2
  echo "  Set META_ADS_ACCOUNT_ID, run 'meta-ads setup', or create ~/.meta-ads-intel/config.json" >&2
  exit 1
fi

CLI="${META_ADS_CLI:-meta-ads}"
DATA_DIR="${META_ADS_DATA_DIR:-$HOME/.meta-ads-intel/data}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Account: $ACCOUNT_ID (source: $ACCOUNT_SOURCE)"

# Warn when results hit the --limit cap (possible silent truncation)
warn_if_truncated() {
  local file="$1" label="$2" limit="${3:-500}"
  local count
  count=$(jq '.data | length' "$file" 2>/dev/null || echo 0)
  if [[ "$count" -ge "$limit" ]]; then
    echo "    WARNING: $label returned $count items (limit $limit reached) — results may be truncated" >&2
  fi
}

# TTL-based cache check: is_cache_fresh <file> <max_age_seconds>
is_cache_fresh() {
  local file="$1" max_age="$2"
  [[ ! -f "$file" ]] && return 1
  local mtime now age
  # macOS stat vs GNU stat
  if stat -f %m "$file" &>/dev/null; then
    mtime=$(stat -f %m "$file")
  else
    mtime=$(stat -c %Y "$file")
  fi
  now=$(date +%s)
  age=$((now - mtime))
  [[ $age -lt $max_age ]]
}

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed. Install with: brew install jq" >&2
  exit 1
fi

# Parse arguments
DATE_PRESET="${1:-last_14d}"

# Update manifest.json and latest.json
update_manifest() {
  local entries=()
  for d in "$DATA_DIR"/????-??-??* ; do
    if [[ -d "$d" ]]; then
      local name
      name=$(basename "$d")
      # Skip special directories
      [[ "$name" == _* ]] && continue
      entries+=("$name")
    fi
  done

  IFS=$'\n' sorted=($(sort <<<"${entries[*]}")); unset IFS

  printf '%s\n' "${sorted[@]}" | jq -R . | jq -s '{entries: ., count: length}' > "$DATA_DIR/manifest.json"

  local count=${#sorted[@]}
  if [[ $count -gt 0 ]]; then
    local last_idx=$((count - 1))
    echo "{\"latest\": \"${sorted[$last_idx]}\"}" | jq . > "$DATA_DIR/latest.json"
  fi

  echo "Manifest updated: ${#sorted[@]} entries available"
}

mkdir -p "$DATA_DIR"

# Prevent concurrent runs from corrupting shared master files
LOCKDIR="$DATA_DIR/.pull-lock"
# Remove stale lock (>30 min old) — likely from a crashed previous run
if [[ -d "$LOCKDIR" ]] && ! is_cache_fresh "$LOCKDIR" 1800; then
  echo "Warning: Removing stale lock (>30 min old): $LOCKDIR" >&2
  rmdir "$LOCKDIR" 2>/dev/null || rm -rf "$LOCKDIR"
fi
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "Error: Another pull-data.sh instance is running (lockdir: $LOCKDIR)." >&2
  echo "  If this is stale, remove it: rmdir $LOCKDIR" >&2
  exit 1
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

# Auto-migrate v2 config keys (target_ctr→ctr, target_engagement_rate→engagement_rate)
if [[ -f "$SKILL_CONFIG" ]] && jq -e '.targets.OUTCOME_TRAFFIC.target_ctr // .targets.OUTCOME_ENGAGEMENT.target_engagement_rate' "$SKILL_CONFIG" &>/dev/null; then
  jq '
    if .targets.OUTCOME_TRAFFIC.target_ctr then .targets.OUTCOME_TRAFFIC.ctr = .targets.OUTCOME_TRAFFIC.target_ctr | del(.targets.OUTCOME_TRAFFIC.target_ctr) else . end |
    if .targets.OUTCOME_ENGAGEMENT.target_engagement_rate then .targets.OUTCOME_ENGAGEMENT.engagement_rate = .targets.OUTCOME_ENGAGEMENT.target_engagement_rate | del(.targets.OUTCOME_ENGAGEMENT.target_engagement_rate) else . end
  ' "$SKILL_CONFIG" > "${SKILL_CONFIG}.tmp" && mv "${SKILL_CONFIG}.tmp" "$SKILL_CONFIG"
  echo "  Migrated config keys (target_ctr→ctr, target_engagement_rate→engagement_rate)"
fi

# ─── Timestamped run directory ──────────────────────────────────────────────
RUN_DIR="$DATA_DIR/$(date '+%Y-%m-%d_%H%M')"
RAW_DIR="$RUN_DIR/_raw"
mkdir -p "$RAW_DIR"

echo "Pulling Meta Ads data ($DATE_PRESET)..."
echo "Run directory: $RUN_DIR"

# Pull period data into _raw/ (3 levels in parallel)
echo "  Pulling period data ($DATE_PRESET)..."
"$CLI" insights get \
  --account-id "$ACCOUNT_ID" \
  --date-preset "$DATE_PRESET" \
  --level campaign \
  --limit 500 \
  -o json > "$RAW_DIR/campaigns.json" &
PID_CAMP=$!

"$CLI" insights get \
  --account-id "$ACCOUNT_ID" \
  --date-preset "$DATE_PRESET" \
  --level adset \
  --limit 500 \
  -o json > "$RAW_DIR/adsets.json" &
PID_ADSET=$!

"$CLI" insights get \
  --account-id "$ACCOUNT_ID" \
  --date-preset "$DATE_PRESET" \
  --level ad \
  --limit 500 \
  -o json > "$RAW_DIR/ads.json" &
PID_AD=$!

# Wait for all and check exit codes
PULL_FAIL=0
wait "$PID_CAMP" || { echo "Error: campaign insights pull failed" >&2; PULL_FAIL=1; }
wait "$PID_ADSET" || { echo "Error: adset insights pull failed" >&2; PULL_FAIL=1; }
wait "$PID_AD" || { echo "Error: ad insights pull failed" >&2; PULL_FAIL=1; }
if [[ $PULL_FAIL -ne 0 ]]; then exit 1; fi

warn_if_truncated "$RAW_DIR/campaigns.json" "period campaigns"
warn_if_truncated "$RAW_DIR/adsets.json" "period adsets"
warn_if_truncated "$RAW_DIR/ads.json" "period ads"

# Campaign metadata — always re-pull (lightweight, provides objective lookup)
"$CLI" campaigns list \
  --account-id "$ACCOUNT_ID" \
  --limit 500 \
  -o json > "$DATA_DIR/campaigns-master.json"
warn_if_truncated "$DATA_DIR/campaigns-master.json" "campaign metadata"
ln -sf "$DATA_DIR/campaigns-master.json" "$RAW_DIR/campaigns-meta.json"

# Creatives (24h TTL — re-pull after launching new ads)
if ! is_cache_fresh "$DATA_DIR/creatives-master.json" 86400; then
  "$CLI" ads list \
    --account-id "$ACCOUNT_ID" \
    --limit 500 \
    -o json > "$DATA_DIR/creatives-master.json"
  warn_if_truncated "$DATA_DIR/creatives-master.json" "ad creatives"
fi
ln -sf "$DATA_DIR/creatives-master.json" "$RAW_DIR/creatives.json"

# Account info (7-day TTL — rarely changes)
if ! is_cache_fresh "$DATA_DIR/account-master.json" 604800; then
  "$CLI" accounts get \
    --account-id "$ACCOUNT_ID" \
    -o json > "$DATA_DIR/account-master.json"
fi
ln -sf "$DATA_DIR/account-master.json" "$RAW_DIR/account.json"

# Summarize _raw/ → summary files in run dir
echo "  Summarizing period data..."
bash "$SCRIPT_DIR/summarize-data.sh" "$RAW_DIR"
if [[ ! -f "$RAW_DIR/campaigns-summary.json" ]]; then
  echo "Error: summarize-data.sh produced no campaigns-summary.json" >&2
  exit 1
fi
# Move summaries to _summaries/ subdir (keep _raw/ clean)
PULL_WARNINGS=()
mkdir -p "$RUN_DIR/_summaries"
mv "$RAW_DIR"/campaigns-summary.json "$RUN_DIR/_summaries/"
if [[ -f "$RAW_DIR/adsets-summary.json" ]]; then
  mv "$RAW_DIR"/adsets-summary.json "$RUN_DIR/_summaries/"
else
  PULL_WARNINGS+=("adsets-summary.json missing — adset-level analysis will be skipped")
fi
if [[ -f "$RAW_DIR/ads-summary.json" ]]; then
  mv "$RAW_DIR"/ads-summary.json "$RUN_DIR/_summaries/"
else
  PULL_WARNINGS+=("ads-summary.json missing — ad-level and creative analysis will be skipped")
fi

# Pull recent window (last_7d) for trend comparison
if [[ "$DATE_PRESET" != "last_7d" ]]; then
  RECENT_RAW="$RUN_DIR/_recent_raw"
  RECENT_DIR="$RUN_DIR/_recent"
  mkdir -p "$RECENT_RAW" "$RECENT_DIR"
  echo "  Pulling recent window (last_7d) for comparison..."

  # Copy campaign metadata so summarization can join objectives
  ln -sf "$DATA_DIR/campaigns-master.json" "$RECENT_RAW/campaigns-meta.json" 2>/dev/null || true

  # Only pull campaign-level for recent window — trends.json only needs campaign data.
  # Skipping adset/ad level saves 2 API calls per run.
  "$CLI" insights get \
    --account-id "$ACCOUNT_ID" \
    --date-preset last_7d \
    --level campaign \
    --limit 500 \
    -o json > "$RECENT_RAW/campaigns.json"
  warn_if_truncated "$RECENT_RAW/campaigns.json" "recent campaigns"

  bash "$SCRIPT_DIR/summarize-data.sh" "$RECENT_RAW"
  if [[ ! -f "$RECENT_RAW/campaigns-summary.json" ]]; then
    echo "Warning: recent-window summarize produced no campaigns-summary.json" >&2
  fi
  mv "$RECENT_RAW"/campaigns-summary.json "$RECENT_DIR/" 2>/dev/null || true
  rm -rf "$RECENT_RAW"
fi

# Write pull warnings for pipeline-status.json
if [[ ${#PULL_WARNINGS[@]} -gt 0 ]]; then
  printf '%s\n' "${PULL_WARNINGS[@]}" | jq -R '[inputs]' > "$RUN_DIR/_pull-warnings.json"
fi

# Run prepare-analysis.sh → 6 agent-ready files + pipeline-status.json
echo "  Preparing analysis files..."
bash "$SCRIPT_DIR/prepare-analysis.sh" "$RUN_DIR"

update_manifest
echo ""
echo "Data pull complete. Run directory: $RUN_DIR"
echo "Agent reads: account-health.json, budget-actions.json, funnel.json, trends.json, creative-analysis.json"
