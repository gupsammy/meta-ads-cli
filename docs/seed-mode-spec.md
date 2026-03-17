# Seed Mode: Daily Historical Backfill

Status: removed from pull-data.sh in v2.0, to be reimplemented when daily WoW comparison is needed.

## What it did (v1)

`pull-data.sh --seed N` backfilled N days of daily snapshots. For each day it pulled campaign/adset/ad insights with `--since YYYY-MM-DD --until YYYY-MM-DD`, creating dated directories. This enabled day-by-day week-over-week comparison (e.g., "was Monday's CPA higher than last Monday?").

## Why it was removed

The v2.0 restructuring changed the data directory layout to timestamped run dirs (`YYYY-MM-DD_HHMM/`) with `_raw/` subdirectories and a `prepare-analysis.sh` post-processing step. Seed mode still used the old flat structure and never called prepare-analysis.sh, so its output was incompatible with the new skill flow.

The primary use case (trend analysis) is now covered by the 30d vs 7d aggregate comparison built into the normal pull flow. Seed mode's daily granularity is a power-user feature that wasn't being used.

## Reimplementation spec

When daily WoW is needed, add `--seed N` back to pull-data.sh with these requirements:

### Directory structure

Each seeded day creates a timestamped run dir matching the v2 format:

```
~/.meta-ads-intel/data/
├── 2026-03-10_0000/    # seeded day (midnight timestamp)
│   ├── _raw/
│   │   ├── campaigns.json
│   │   ├── adsets.json
│   │   ├── ads.json
│   │   ├── creatives.json
│   │   └── account.json
│   ├── campaigns-summary.json
│   ├── adsets-summary.json
│   ├── ads-summary.json
│   ├── account-health.json
│   ├── budget-actions.json
│   ├── funnel.json
│   ├── trends.json          # available: false (no recent window for single-day pulls)
│   ├── creative-analysis.json
│   └── creative-media.json
├── 2026-03-11_0000/
│   └── ...
```

Use `_0000` as the time component for seeded days (distinguishes from live runs which have real timestamps).

### Pipeline per day

For each day in the seed range:
1. `pull_raw "$day" "$day" "$RUN_DIR/_raw"` — same as normal mode
2. `summarize-data.sh "$RUN_DIR/_raw"` — produce summaries
3. Move summaries from `_raw/` to `$RUN_DIR/`
4. `prepare-analysis.sh "$RUN_DIR"` — produce analysis files
5. trends.json will output `{"available": false}` since there's no `_recent/` dir — this is expected for daily snapshots

### WoW comparison (new script)

Seed mode's value is WoW comparison. Add a new `compare-days.sh` script:

```
compare-days.sh <day1-run-dir> <day2-run-dir>
```

Reads `account-health.json` from both dirs, computes deltas (spend, CPA, ROAS, purchases). Outputs a `wow-comparison.json` with per-campaign deltas similar to trends.json but comparing two specific days.

The skill's SKILL.md would add an optional step: "If manifest.json contains a run from ~7 days ago, read its account-health.json and compare with the current run for WoW deltas."

### API call budget

Seeding N days = N * 4 API calls (campaigns + adsets + ads + creatives, though creatives is cached). For 7 days = 28 calls. Meta's rate limit is ~200/hour/account, so a 7-day seed is safe. A 30-day seed (120 calls) should add a 1-second delay between days to stay under limits.

### SKILL.md integration

Add to Step 6 (Trend Analysis): "Also check manifest.json for a run from ~7 days ago. If found, compare its account-health.json with the current run for week-over-week deltas."

No new analysis files needed — the agent reads two existing account-health.json files and computes WoW inline. This keeps the reasoning (interpreting why WoW changed) with the agent rather than in a script.
