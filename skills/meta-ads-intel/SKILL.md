---
name: meta-ads-intel
description: >
  This skill should be used when the user says "analyze my ads", "meta ads report",
  "campaign performance", "budget optimization", "creative analysis", "ads intelligence",
  "weekly ads brief", "ad account health", or wants performance insights from Meta
  advertising data. Not for creating/updating campaigns or writing ad copy.
license: MIT
compatibility: >
  Requires meta-ads CLI (npm i -g meta-ads), jq, and optionally ffmpeg/ffprobe
  for visual creative analysis. Node.js >= 20.
metadata:
  author: gupsammy
  version: "2.0"
---

# Meta Ads Intelligence

Analyze Meta Ads campaign data and produce actionable intelligence: budget optimization, creative performance rankings, trend analysis, funnel diagnostics, and a strategic decision brief.

Arguments: `$ARGUMENTS` — optional date preset (default: last_14d). Valid: last_7d, last_14d, last_30d, last_90d, this_month, last_month.

## Data Architecture

Scripts handle all data pulling, summarization, and computation. Read only the 6 pre-computed analysis files — never raw data.

```
~/.meta-ads-intel/
├── config.json          # account + targets + analysis params
├── brand-context.md     # product, audience, hooks (created by onboarding)
├── data/
│   └── YYYY-MM-DD_HHMM/ # timestamped run (never overwritten)
│       ├── _raw/          # raw API responses — NEVER read these
│       ├── _recent/       # recent window summaries (for trends)
│       ├── account-health.json     ── agent reads these 6 ──
│       ├── budget-actions.json
│       ├── funnel.json
│       ├── trends.json
│       ├── creative-analysis.json
│       └── creative-media.json     # for analyze-creatives.sh only
├── reports/
└── creatives/
```

## Process

### 0. Mode Gate

Check config:
```bash
jq -e '.account_id' ~/.meta-ads-intel/config.json 2>/dev/null
```

**ONBOARDING MODE** (config missing or invalid):
Read `references/onboarding.md` and follow that flow completely. Onboarding is a dedicated session — it installs the CLI, collects brand context, runs a creative scan, sets targets, and writes config.json. When onboarding says "Setup complete" — STOP. Do NOT continue to Step 1. The user runs /meta-ads-intel again for their first analysis.

**ANALYSIS MODE** (config exists and valid):
Proceed to Step 1.

### 1. Load Configuration

Read `~/.meta-ads-intel/config.json` for account ID, targets, analysis params.
Read `references/thresholds.md` for budget classification interpretation rules and objective-specific guidance.
Read `references/metrics.md` for field definitions and metric interpretation.
Read `references/brand-copy.md` for copy psychology framework (Four Horsemen, copy specs, forbidden words). Read `~/.meta-ads-intel/brand-context.md` for user's brand context (product, audience, proven hooks). This file is created during onboarding and must exist in analysis mode.

### 2. Run Analysis Pipeline

```bash
bash <skill-dir>/scripts/run-analysis.sh $ARGUMENTS
```
`<skill-dir>` is the directory containing this SKILL.md. Resolve from this file's path at runtime.

This single script chains the full pipeline: pull raw API data → summarize → compute 6 analysis files → extract visual creative artifacts (if ffmpeg available). No further scripts to run.

If ffmpeg is not available, the script logs "SKIPPED: ffmpeg/ffprobe not installed" with install instructions. Note this in the analysis — visual creative analysis was skipped, and the user can install ffmpeg (`brew install ffmpeg`) for future runs.

If script fails (auth expired, network, missing account), report error and stop.

Identify the run directory from script output (printed as "Run directory: ..."). All subsequent reads come from this directory.

### 3. Account Health

Read `account-health.json` from the run directory.

This contains both blended (all campaigns) and sales-specific (OUTCOME_SALES only) metrics. Use `sales_cpa` and `sales_roas` for target comparisons — blended metrics include non-conversion campaign spend that dilutes CPA/ROAS. The `non_sales_campaigns` array shows what was excluded (campaign name, objective, spend). Mention non-sales spend in the scorecard for context but don't evaluate it against CPA/ROAS targets. Flag any sales metric missing target by >20%.

### 4. Budget Actions

Read `budget-actions.json` from the run directory.

Pre-classified by `prepare-analysis.sh` into scale/reduce/pause/refresh/maintain buckets with reason strings. Only OUTCOME_SALES adsets are included — non-sales adsets are excluded (see `summary.excluded_non_sales` count). The agent's job is to add judgment:

- Learning phase? New campaigns (< 7 days) classified as "reduce" or "pause" may need protection.
- Scale recommendations — suggest specific budget increase amounts (e.g., "increase daily budget by 20%").
- Pause recommendations — check if the adset is the only one in its campaign before recommending pause.

Use `references/thresholds.md` interpretation rules for nuance.

### 5. Funnel Analysis

Read `funnel.json` from the run directory.

Filtered to OUTCOME_SALES campaigns only — non-sales campaigns (traffic, awareness) are excluded to prevent funnel dilution. The `filter` object shows how many campaigns were included vs excluded and how much non-sales spend was omitted. Contains: stage counts (impressions → clicks → landing pages → add to cart → checkout → purchase), conversion rates between stages, identified bottleneck (lowest conversion rate stage), and an `engagement` block. The `engagement` block reports `view_content` count and `browse_depth` (view_content / landing_page_views) as a separate metric — browse_depth > 1 means visitors view multiple products per session.

Interpret the bottleneck:
- TOFU (click/landing): targeting or ad relevance issue
- MOFU (landing_to_cart): product page or offer issue
- BOFU (cart_to_checkout, checkout_to_purchase): trust, payment, or friction issue

Connect to specific campaign or adset recommendations from Step 4.

### 6. Trend Analysis

Read `trends.json` from the run directory.

If `available: true`: contains per-campaign deltas (OUTCOME_SALES campaigns only) between the full period and the recent 7-day window. The `flagged` array highlights campaigns where ROAS declined >15% or CPA rose >15%.

Identify concerning patterns: accelerating fatigue (frequency rising + ROAS declining), spend shifting without performance improvement, campaigns that were strong in the period but weakening recently.

If `available: false`: note that trend data requires a comparison window and recommend running with `last_14d` preset (default).

### 7. Creative Analysis

Read `creative-analysis.json` from the run directory. This is the highest-value analysis step — where agent intelligence matters most. Do not skip or abbreviate any sub-step.

Contains pre-filtered top N winners (by ROAS), bottom N losers, and zero-purchase ads with significant spend. Each includes `creative_body` and `creative_title` — the actual ad copy text.

MUST complete all of the following:

1. Classify each winner's copy using the Four Horsemen framework from `references/brand-copy.md` (Money/Time/Status/Fear). State which lever each winning ad pulls and why. If creative_body is empty (video-only ad), note this — it's a signal that video outperforms static copy.

2. Compare messaging angles: what do winners have in common that losers lack? Look for patterns in specificity vs vagueness, emotional vs rational tone, sentence length, use of numbers, opening hooks. Quote specific copy from winners and losers to illustrate.

3. Flag zero-purchase ads with their total wasted spend. These are budget leaks — recommend pause or replacement with a winning angle.

4. If `~/.meta-ads-intel/creatives/manifest.json` exists (visual artifacts were extracted by run-analysis.sh), read the manifest and then read 2-3 winner frames and 2-3 loser frames via Read tool. Compare visual patterns: opening hooks, text overlays, color palettes, product visibility, video pacing. If manifest doesn't exist, note that visual analysis was skipped (ffmpeg not installed).

5. Synthesize: which creative directions should be scaled (new variants in the same angle), which should be killed, and what net-new angles are untested?

### 8. Decision Brief

Synthesize all analysis into:

- Account Health: spend, purchases, blended CPA/ROAS vs targets
- Trends: period vs recent scorecard, biggest movers
- Top 3 Actions: highest-leverage changes with specific budget amounts and expected impact
- Risks: fatigue signals, underperforming spend, drifting campaigns
- Creative Insights: messaging/visual patterns correlating with performance
- Watch Items: learning-phase campaigns, insufficient-data tests

### 9. Save Output

Write to `~/.meta-ads-intel/reports/`:
1. `report-{YYYY-MM-DD}.md` — full markdown brief
2. `data-{YYYY-MM-DD}.json` — structured JSON (account health, funnel, budget actions, trends, creative rankings, recommendations)

Return concise summary: account health headline, top 3 actions, report paths.

## Rules

- NEVER read files in `_raw/` directories. These contain verbose API responses with 40+ duplicate action types per row.
- NEVER read `*-summary.json` files directly. These are intermediate files consumed by `prepare-analysis.sh`.
- NEVER read `creative-media.json` — it's input for `analyze-creatives.sh` only.
- Only read the 5 analysis files: `account-health.json`, `budget-actions.json`, `funnel.json`, `trends.json`, `creative-analysis.json`. Also read `~/.meta-ads-intel/creatives/manifest.json` and selected frames when visual artifacts exist.
- All monetary values in analysis files are in the account's currency (not minor units — scripts already convert).
