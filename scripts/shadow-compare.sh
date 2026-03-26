#!/bin/bash
set -euo pipefail

# Shadow comparison: run shell summarize+prepare on TS pipeline's raw data,
# then diff the outputs to verify equivalence before cutover.
#
# Usage: shadow-compare.sh [run-dir]
#   Defaults to the latest run from ~/.meta-ads-intel/data/latest.json

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHELL_SCRIPTS="$PROJECT_ROOT/skills/meta-ads-intel/scripts"
DIFFER="$SCRIPT_DIR/shadow-differ.mjs"

DATA_DIR="${META_ADS_DATA_DIR:-$HOME/.meta-ads-intel/data}"

# ── Phase 1: Resolve TS run directory ──────────────────────────────

if [[ -n "${1:-}" ]]; then
  TS_RUN="$1"
else
  if [[ ! -f "$DATA_DIR/latest.json" ]]; then
    echo "Error: No latest.json found. Run 'meta-ads intel run' first." >&2
    exit 1
  fi
  LATEST=$(jq -r '.latest' "$DATA_DIR/latest.json")
  TS_RUN="$DATA_DIR/$LATEST"
fi

echo "=== Shadow Comparison ==="
echo "TS run dir: $TS_RUN"
echo ""

for required in _raw/campaigns.json _raw/adsets.json _raw/ads.json _summaries/campaigns-summary.json; do
  if [[ ! -f "$TS_RUN/$required" ]]; then
    echo "Error: Missing $required in TS run dir" >&2
    exit 1
  fi
done

# ── Phase 2: Create temp workspace ────────────────────────────────

WORK_DIR=$(mktemp -d /tmp/shadow-compare-XXXX)
trap 'rm -rf "$WORK_DIR"' EXIT
echo "Temp workspace: $WORK_DIR"

# Copy _raw/ dereferencing symlinks so shell scripts get real files
cp -RL "$TS_RUN/_raw/" "$WORK_DIR/shell-raw/"

# Set up parallel run dir structure for prepare-analysis.sh
mkdir -p "$WORK_DIR/shell-run/_summaries"

# Link _raw/ into shell-run so prepare-analysis.sh can find creatives.json for URL lookup
ln -s "$WORK_DIR/shell-raw" "$WORK_DIR/shell-run/_raw"

# Copy _recent/ if it exists (for trends comparison)
if [[ -d "$TS_RUN/_recent" ]]; then
  cp -RL "$TS_RUN/_recent/" "$WORK_DIR/shell-run/_recent/"
fi

# ── Phase 3: Run shell pipeline ───────────────────────────────────

echo ""
echo "Running shell summarize-data.sh..."
bash "$SHELL_SCRIPTS/summarize-data.sh" "$WORK_DIR/shell-raw/"

# Move shell summaries into the run dir structure prepare expects
for f in campaigns-summary.json adsets-summary.json ads-summary.json; do
  if [[ -f "$WORK_DIR/shell-raw/$f" ]]; then
    cp "$WORK_DIR/shell-raw/$f" "$WORK_DIR/shell-run/_summaries/$f"
  fi
done

echo "Running shell prepare-analysis.sh..."
bash "$SHELL_SCRIPTS/prepare-analysis.sh" "$WORK_DIR/shell-run/"

# ── Phase 4: Compare ─────────────────────────────────────────────

echo ""
echo "=== Comparison Results ==="
echo ""

REPORTS=()
HAS_UNEXPECTED=0

run_diff() {
  local name="$1" ts_file="$2" shell_file="$3"

  if [[ ! -f "$ts_file" ]]; then
    printf "  %-30s MISSING (no TS file)\n" "$name" >&2
    HAS_UNEXPECTED=1
    return
  fi
  if [[ ! -f "$shell_file" ]]; then
    printf "  %-30s MISSING (no shell file)\n" "$name" >&2
    HAS_UNEXPECTED=1
    return
  fi

  local report
  report=$(node "$DIFFER" "$ts_file" "$shell_file" "$name" 2>/dev/null) || {
    printf "  %-30s ERROR (differ failed)\n" "$name" >&2
    HAS_UNEXPECTED=1
    return
  }
  local verdict rounding known unexpected
  verdict=$(echo "$report" | jq -r '.verdict')
  rounding=$(echo "$report" | jq -r '.rounding_diffs')
  known=$(echo "$report" | jq -r '.known_fixes')
  unexpected=$(echo "$report" | jq -r '.unexpected_diffs')

  local detail="" null_zero
  null_zero=$(echo "$report" | jq -r '.null_zero_diffs')
  if [[ "$rounding" -gt 0 ]]; then detail+="${rounding} rounding"; fi
  if [[ "$null_zero" -gt 0 ]]; then
    [[ -n "$detail" ]] && detail+=", "
    detail+="${null_zero} null/zero"
  fi
  if [[ "$known" -gt 0 ]]; then
    [[ -n "$detail" ]] && detail+=", "
    detail+="${known} known fix"
  fi
  if [[ "$unexpected" -gt 0 ]]; then
    [[ -n "$detail" ]] && detail+=", "
    detail+="${unexpected} unexpected"
    HAS_UNEXPECTED=1
  fi
  [[ -z "$detail" ]] && detail="exact"

  printf "  %-30s %-20s (%s)\n" "$name" "$verdict" "$detail"
  REPORTS+=("$report")
}

echo "Layer: Summarize"
run_diff "campaigns-summary.json" "$TS_RUN/_summaries/campaigns-summary.json" "$WORK_DIR/shell-raw/campaigns-summary.json"
run_diff "adsets-summary.json"    "$TS_RUN/_summaries/adsets-summary.json"    "$WORK_DIR/shell-raw/adsets-summary.json"
run_diff "ads-summary.json"       "$TS_RUN/_summaries/ads-summary.json"       "$WORK_DIR/shell-raw/ads-summary.json"

echo ""
echo "Layer: Prepare"
for f in account-health.json budget-actions.json funnel.json trends.json creative-analysis.json creative-media.json; do
  run_diff "$f" "$TS_RUN/$f" "$WORK_DIR/shell-run/$f"
done

# ── Phase 5: Report ──────────────────────────────────────────────

echo ""

# Write full JSON report
REPORT_PATH="$SCRIPT_DIR/shadow-compare-report.json"
printf '[' > "$REPORT_PATH"
for i in "${!REPORTS[@]}"; do
  [[ $i -gt 0 ]] && printf ',' >> "$REPORT_PATH"
  echo "${REPORTS[$i]}" >> "$REPORT_PATH"
done
printf ']' >> "$REPORT_PATH"

# Pretty-print the report file
jq '.' "$REPORT_PATH" > "$REPORT_PATH.tmp" && mv "$REPORT_PATH.tmp" "$REPORT_PATH"

echo "Full report: $REPORT_PATH"

if [[ "$HAS_UNEXPECTED" -eq 1 ]]; then
  echo ""
  echo "UNEXPECTED DIFFS found. Details:"
  jq '[.[] | select(.unexpected_diffs > 0) | {file, details: [.details[] | select(.class == "unexpected")]}]' "$REPORT_PATH"
  exit 1
else
  echo "All diffs acceptable."
  exit 0
fi
