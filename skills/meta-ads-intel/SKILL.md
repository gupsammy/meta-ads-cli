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
  version: "3.0"
---

# Meta Ads Intelligence

Analyze Meta Ads campaign data and produce actionable intelligence: budget optimization, creative performance rankings, trend analysis, funnel diagnostics, and a strategic decision brief. Supports all campaign objectives (Sales, Traffic, Awareness, Engagement, Leads, App Promotion) with per-objective KPIs.

Arguments: `$ARGUMENTS` — optional date preset (default: last_14d). Valid: last_7d, last_14d, last_30d, last_90d, this_month, last_month.

## Data Architecture

Scripts handle all data pulling, summarization, and computation. The pipeline produces 6 output files; the agent reads 5 directly (creative-media.json is consumed only by analyze-creatives.sh for visual artifact extraction). All analysis files are objective-aware: data is grouped by campaign objective with per-objective KPIs and classifications.

```
~/.meta-ads-intel/
├── config.json          # account + per-objective targets + analysis params (v2)
├── brand-context.md     # product, audience, hooks (created by onboarding)
├── data/
│   └── YYYY-MM-DD_HHMM/ # timestamped run (never overwritten)
│       ├── _raw/          # raw API responses — NEVER read these
│       ├── _summaries/    # intermediate summaries — NEVER read these
│       ├── _recent/       # recent window summaries (for trends)
│       ├── account-health.json     ── agent reads these 6 ──
│       ├── budget-actions.json
│       ├── funnel.json
│       ├── trends.json
│       ├── creative-analysis.json
│       ├── creative-media.json     # for analyze-creatives.sh only
│       └── pipeline-status.json    # check before reading analysis files
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
Read `references/onboarding.md` and follow that flow completely. Onboarding is a dedicated session — it installs the CLI, collects brand context, auto-detects objectives, runs a creative scan, sets per-objective targets, and writes config.json v2. When onboarding says "Setup complete" — STOP. Do NOT continue to Step 1. The user runs /meta-ads-intel again for their first analysis.

**RECONFIGURE MODE** (`$ARGUMENTS` contains "reconfigure"):
Config exists but user wants to update settings. Read `references/onboarding.md` → "Reconfigure Mode" section. This allows selective updates (targets, brand context, or full re-onboarding) without repeating install/auth. When reconfigure says "Config updated" — STOP.

**ANALYSIS MODE** (config exists and valid):
Proceed to Step 1.

### 1. Load Configuration

Read `~/.meta-ads-intel/config.json` for account ID, per-objective targets, analysis params, and `primary_objective`.
Read `references/thresholds.md` for per-objective budget classification rules and interpretation guidance.
Read `references/metrics.md` for field definitions and per-objective metric interpretation.
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

First, read `pipeline-status.json`. If `status` is `"partial"`, check `files_skipped` and `warnings` — report missing data to the user before proceeding. Only read files listed in `files_produced`.

### 3. Account Health

Read `account-health.json` from the run directory.

This contains per-objective sections keyed by objective name (e.g., `OUTCOME_SALES`, `OUTCOME_TRAFFIC`). Each section has its own KPIs and target comparisons. The `primary_objective` field indicates which objective gets the most weight in the scorecard.

For each objective present:
- **OUTCOME_SALES**: Compare `cpa` and `roas` against `target_cpa`/`target_roas`. Flag if missing target by >20%.
- **OUTCOME_TRAFFIC**: Compare `cpc` and `ctr` against `target_cpc`/`target_ctr`.
- **OUTCOME_AWARENESS**: Compare `cpm` against `target_cpm`. Check `avg_frequency` against ceiling.
- **OUTCOME_ENGAGEMENT**: Compare `cpe` against `target_cpe`. Report `engagement_rate`.
- **OUTCOME_LEADS**: Compare `cpl` against `target_cpl`.
- **OUTCOME_APP_PROMOTION**: Compare `cpi` against `target_cpi`.

Report `total_spend` and spend breakdown across objectives for context. Note: `total_reach` sums reach across objectives — users reached by multiple campaigns are counted once per campaign, so the total overstates unique reach. Lead with the primary objective's scorecard, then cover others.

### 4. Budget Actions

Read `budget-actions.json` from the run directory.

Per-objective sections, each pre-classified by `prepare-analysis.sh` into scale/reduce/pause/refresh/maintain buckets with reason strings. Each objective uses its own KPIs for classification (see `references/thresholds.md`). The agent's job is to add judgment:

- Learning phase? New campaigns (< 7 days) classified as "reduce" or "pause" may need protection.
- Scale recommendations — suggest specific budget increase amounts (e.g., "increase daily budget by 20%").
- Pause recommendations — check if the adset is the only one in its campaign before recommending pause.
- Cross-objective context: a traffic campaign feeding into a sales funnel may deserve more patience even if its own CPC is high.

Use `references/thresholds.md` interpretation rules for nuance.

### 5. Funnel Analysis

Read `funnel.json` from the run directory.

Per-objective sections with different funnel shapes. Expected rates for bottleneck detection are sourced from `funnel_expected_rates` in config.json (configurable during onboarding) with hardcoded industry defaults as fallback. Check the `type` field:
- `"funnel"`: conversion stages with bottleneck detection. Interpret the bottleneck stage.
- `"reach_efficiency"`: awareness metrics (no conversion funnel). Report CPM, frequency, reach rate.

**OUTCOME_SALES** (full 7-stage funnel):
- TOFU (click/landing): targeting or ad relevance issue
- MOFU (landing_to_cart): product page or offer issue
- BOFU (cart_to_checkout, checkout_to_purchase): trust, payment, or friction issue

**OUTCOME_TRAFFIC** (3-stage): impression → click → landing page. Low landing rate = slow page or bad mobile UX.

**OUTCOME_ENGAGEMENT** (3-stage): impression → post engagement → page engagement. Low deep engagement = content not compelling enough for follow-through.

**OUTCOME_LEADS** (4-stage): impression → click → landing → lead. Low lead conversion = form friction or targeting mismatch.

**OUTCOME_APP_PROMOTION** (3-stage): impression → click → install. Low install rate = store listing issue or targeting.

Connect bottlenecks to specific campaign or adset recommendations from Step 4.

### 6. Trend Analysis

Read `trends.json` from the run directory.

If `available: true`: contains per-campaign deltas between the recent 7-day window and the prior window (full period minus recent). Each campaign entry includes its `objective` and objective-appropriate delta metrics:
- Sales: `cpa_delta_pct`, `roas_delta_pct`
- Traffic: `cpc_delta_pct`, `ctr_delta_pct`
- Awareness: `cpm_delta_pct`
- Engagement: `cpe_delta_pct`
- Leads: `cpl_delta_pct`
- App: `cpi_delta_pct`

Frequency is reported as `period_frequency` and `recent_frequency` raw values — compare directionally, no computed delta. A rising frequency alongside declining KPIs is a strong fatigue signal.

The `flagged` array highlights campaigns where the primary KPI deteriorated >15%. The `flags` array per campaign shows specific deterioration signals.

If `recently_inactive` contains campaigns, note they were active earlier in the period but had no recent activity — potential pauses or budget exhaustion.

Identify concerning patterns: accelerating fatigue (frequency rising + KPI declining), spend shifting without performance improvement, campaigns that were strong in the period but weakening recently.

If `available: false`: note that trend data requires a comparison window and recommend running with `last_14d` preset (default).

### 7. Creative Analysis

Read `creative-analysis.json` from the run directory. This is the highest-value analysis step — where agent intelligence matters most. Do not skip or abbreviate any sub-step.

If an objective has 0 ads (empty winners/losers arrays), note this and explain why — typically the objective's adsets fell below the min_spend threshold. Do not fabricate analysis for empty data.

Contains per-objective sections. Each has winners (ranked by objective-appropriate metric), losers, and zero-conversion ads. Each includes `creative_body` and `creative_title` — the actual ad copy text.

For awareness, zero_conversion means zero video views. For reach-only awareness campaigns (no video), all ads will have conversions — focus on CPM comparison instead.

For traffic, winners are ranked by CTR. Cross-reference CPC — high CTR with high CPC may indicate a targeting or placement issue, not a true winner.

For the primary objective (and any other objective with significant spend):

1. Classify each winner's copy using the Four Horsemen framework from `references/brand-copy.md` (Money/Time/Status/Fear). State which lever each winning ad pulls and why. If creative_body is empty (video-only ad), note this — it's a signal that video outperforms static copy.

2. Compare messaging angles: what do winners have in common that losers lack? Look for patterns in specificity vs vagueness, emotional vs rational tone, sentence length, use of numbers, opening hooks. Quote specific copy from winners and losers to illustrate.

3. Flag zero-conversion ads with their total wasted spend. These are budget leaks — recommend pause or replacement with a winning angle. Note which objective each belongs to.

4. If `~/.meta-ads-intel/creatives/manifest.json` exists (visual artifacts were extracted by run-analysis.sh), read the manifest and then read 2-3 winner frames and 2-3 loser frames via Read tool. Compare visual patterns: opening hooks, text overlays, color palettes, product visibility, video pacing. If manifest doesn't exist, note that visual analysis was skipped (ffmpeg not installed).

5. Synthesize: which creative directions should be scaled (new variants in the same angle), which should be killed, and what net-new angles are untested? Note which objective each recommendation applies to.

### 8. Decision Brief

**Cross-run comparison**: Before synthesizing, check for previous report data. If `~/.meta-ads-intel/reports/data-*.json` files exist from earlier runs, read the most recent one (sort by filename descending — filenames embed ISO date) and compute deltas for primary objective KPIs (e.g., CPA change, ROAS change since last analysis). Include a "vs. Last Analysis" line in Account Health.

Synthesize all analysis into:

- Account Health: total spend, per-objective spend breakdown, primary objective KPIs vs targets (+ vs. last analysis if available)
- Trends: period vs recent scorecard per objective, biggest movers
- Top 3 Actions: highest-leverage changes with specific budget amounts and expected impact. Prioritize the primary objective but include cross-objective synergies (e.g., "traffic campaign X is feeding sales funnel Y")
- Risks: fatigue signals, underperforming spend, drifting campaigns across all objectives
- Creative Insights: messaging/visual patterns correlating with performance, organized by objective
- Watch Items: learning-phase campaigns, insufficient-data tests

### 9. Save Output

Write to `~/.meta-ads-intel/reports/`:
1. `report-{YYYY-MM-DD}.md` — full markdown brief
2. `data-{YYYY-MM-DD}.json` — structured JSON (account health, funnel, budget actions, trends, creative rankings, recommendations)

Return concise summary: account health headline, top 3 actions, report paths.

If this is the user's first analysis, suggest weekly scheduling: "For automated weekly analysis, set up a system scheduler. On macOS: a launchd plist at `~/Library/LaunchAgents/com.meta-ads-intel.weekly.plist` that runs `claude -p '/meta-ads-intel'`. On Linux: a crontab entry. Requires Claude Code CLI on PATH." Offer to create the plist/crontab if the user is interested.

## Rules

- NEVER read files in `_raw/` directories. These contain verbose API responses with 40+ duplicate action types per row.
- NEVER read `*-summary.json` files directly. These are intermediate files consumed by `prepare-analysis.sh`.
- NEVER read `creative-media.json` — it's input for `analyze-creatives.sh` only.
- Only read the 5 agent-facing analysis files: `account-health.json`, `budget-actions.json`, `funnel.json`, `trends.json`, `creative-analysis.json`. The 6th file (`creative-media.json`) is consumed only by `analyze-creatives.sh`. Also read `~/.meta-ads-intel/creatives/manifest.json` and selected frames when visual artifacts exist.
- All monetary values in analysis files are in the account's currency (not minor units — scripts already convert).
