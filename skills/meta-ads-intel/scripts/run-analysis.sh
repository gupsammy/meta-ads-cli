#!/bin/bash
set -e

# Single entry point for the full Meta Ads analysis pipeline.
# Chains: pull-data.sh → analyze-creatives.sh (if ffmpeg available).
#
# Usage: run-analysis.sh [date-preset]
# Date presets: last_7d, last_14d, last_30d, last_90d, this_month, last_month

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATE_PRESET="${1:-last_14d}"

# ─── Step 1: Pull data + summarize + prepare analysis files ─────────────────
echo "=== Phase 1: Data Pull & Analysis ==="
bash "$SCRIPT_DIR/pull-data.sh" "$DATE_PRESET"

# Extract run directory from latest.json (pull-data.sh updates it)
DATA_DIR="${META_ADS_DATA_DIR:-$HOME/.meta-ads-intel/data}"
LATEST_FILE="$DATA_DIR/latest.json"
if [[ ! -f "$LATEST_FILE" ]]; then
  echo "Error: latest.json not found after pull-data.sh" >&2
  exit 1
fi
RUN_DIR="$DATA_DIR/$(jq -r '.latest' "$LATEST_FILE")"

# ─── Step 2: Visual creative analysis (if ffmpeg available) ─────────────────
echo ""
echo "=== Phase 2: Visual Creative Analysis ==="
if command -v ffmpeg &>/dev/null && command -v ffprobe &>/dev/null; then
  MEDIA_FILE="$RUN_DIR/creative-media.json"
  if [[ -f "$MEDIA_FILE" ]] && [[ "$(jq 'length' "$MEDIA_FILE")" -gt 0 ]]; then
    echo "ffmpeg available. Extracting creative artifacts..."
    bash "$SCRIPT_DIR/analyze-creatives.sh" "$MEDIA_FILE"
  else
    echo "SKIPPED: creative-media.json is empty or missing."
  fi
else
  echo "SKIPPED: ffmpeg/ffprobe not installed."
  echo "  Install with: brew install ffmpeg"
  echo "  Visual creative analysis compares winner/loser ad imagery and video hooks."
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "=== Analysis Complete ==="
echo "Run directory: $RUN_DIR"
echo ""
echo "Agent reads:"
echo "  1. account-health.json    — headline scorecard"
echo "  2. budget-actions.json    — pre-classified adset actions"
echo "  3. funnel.json            — conversion funnel + bottleneck"
echo "  4. trends.json            — period vs recent deltas"
echo "  5. creative-analysis.json — top/bottom ads with copy text"
_CREATIVES_DIR="$(dirname "${META_ADS_DATA_DIR:-$HOME/.meta-ads-intel/data}")/creatives"
if [[ -f "$_CREATIVES_DIR/manifest.json" ]]; then
  CREATIVE_COUNT=$(jq 'length' "$_CREATIVES_DIR/manifest.json" 2>/dev/null || echo 0)
  echo "  6. creatives/manifest.json — $CREATIVE_COUNT visual artifacts extracted"
else
  echo "  6. (no visual artifacts — ffmpeg not available)"
fi
