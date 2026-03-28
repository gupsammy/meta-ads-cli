---
name: meta-ads-intel
description: >
  This skill should be used when the user says "analyze my ads", "meta ads report",
  "campaign performance", "budget optimization", "creative analysis", "ads intelligence",
  "weekly ads brief", "ad account health", or wants performance insights from Meta
  advertising data. Not for creating/updating campaigns or writing ad copy.
license: MIT
compatibility: >
  Requires meta-ads CLI (npm i -g meta-ads) and optionally ffmpeg/ffprobe
  for visual creative analysis. Node.js >= 20.
metadata:
  author: gupsammy
  version: "3.0"
---

# Meta Ads Intelligence

Analyze Meta Ads campaign data and produce actionable intelligence: budget optimization, creative performance rankings, trend analysis, funnel diagnostics, and a strategic decision brief. Supports all campaign objectives (Sales, Traffic, Awareness, Engagement, Leads, App Promotion) with per-objective KPIs.

Arguments: `$ARGUMENTS` — optional date preset (default: last_14d). Valid: last_7d, last_14d, last_30d, last_90d, this_month, last_month.

## Data Architecture

The CLI handles all data pulling, summarization, and computation. The pipeline produces 7 output files; the agent reads 6 directly (creative-media.json is consumed internally by the pipeline for visual artifact extraction). All analysis files are objective-aware: data is grouped by campaign objective with per-objective KPIs and classifications.

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
│       ├── recommendations.json      # may be absent (see Step 4)
│       ├── creative-media.json     # internal pipeline use only
│       └── pipeline-status.json    # check before reading analysis files
├── reports/
└── creatives/
```

## Process

### 0. Mode Gate

Check config — read `~/.meta-ads-intel/config.json` and verify it contains a valid `account_id` field. If the file is missing, unreadable, or lacks `account_id`, enter onboarding mode.

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
meta-ads intel run $ARGUMENTS -o json
```

This command runs the full pipeline: pull raw API data → summarize → compute 7 analysis files → extract visual creative artifacts (if ffmpeg available).

If ffmpeg is not available, the command logs a note to stderr. Note this in the analysis — visual creative analysis was skipped, and the user can install ffmpeg (`brew install ffmpeg`) for future runs.

If the command fails (auth expired, network, missing account), report error and stop.

The command outputs JSON to stdout:
```json
{"run_dir": "...", "status": "complete|partial", "files_produced": [...], "files_skipped": [...], "warnings": [...], "creatives": {"total_ads": N, "total_frames": N}}
```
The `creatives` field is present only when ffmpeg extracted visual artifacts.

Read `run_dir` from the output — all subsequent reads come from this directory. If `status` is `"partial"`, check `files_skipped` and `warnings` — report missing data to the user before proceeding. Only read files listed in `files_produced`. Proceed with analysis for all produced files. For each step that requires a missing file, skip that step and note "Skipped: [filename] not produced" in the decision brief. Never abort the full analysis because one file is missing.

If warnings mention truncation or data limits, note this prominently in Step 9: "Analysis covers a capped sample of ads. Rankings reflect the pipeline's top/bottom selection, not the full ad set."

### 3. Account Health

Read `account-health.json` from the run directory.

This contains per-objective sections keyed by objective name (e.g., `OUTCOME_SALES`, `OUTCOME_TRAFFIC`). Each section has its own KPIs and target comparisons. The `primary_objective` field indicates which objective gets the most weight in the scorecard.

For each objective present, compare the KPI fields in that objective's block against the corresponding `target_*` fields. Use `references/thresholds.md` for objective-specific KPI definitions and interpretation rules. Flag any KPI missing target by >20%. If `target_cpv` is present in config for Awareness campaigns, also evaluate CPV.

Report `total_spend` and spend breakdown across objectives for context. Note: `total_reach` sums reach across objectives — users reached by multiple campaigns are counted once per campaign, so the total overstates unique reach. Lead with the primary objective's scorecard, then cover others.

### 4. Recommendations (Meta API)

Read `recommendations.json` from the run directory — only if listed in `files_produced`. If not produced, skip this step silently. Recommendations require specific API permissions and may not be available for all accounts.

This file contains Meta's own account-level optimization analysis:
- `opportunity_score` (0-100): report alongside Step 3 KPIs as a health signal
- `data` array: each entry has `type`, `description`, `estimated_impact_score` (points), `estimated_impact_pct` (lift %), and `api_apply_supported` (boolean)

Note the top recommendations by `estimated_impact_score` for cross-referencing in Step 9. Report `opportunity_score` alongside Step 3 KPIs. Flag `api_apply_supported: true` entries as quick-win candidates (note: CLI cannot apply these yet — flag for manual action in Ads Manager).

If `recommendations.json` exists but `data` is an empty array, report "Meta returned no current recommendations for this account" and note `opportunity_score`. Do not treat an empty array as an error.

Do not list all recommendations verbatim. Prioritize by `estimated_impact_score` and relevance to the primary objective. Full grouping (confirms/surfaces/conflicts) happens in Step 9 after all analysis is complete.

### 5. Budget Actions

Read `budget-actions.json` from the run directory.

Per-objective sections, each pre-classified into scale/reduce/pause/refresh/maintain buckets with reason strings. Each objective uses its own KPIs for classification (see `references/thresholds.md`). The agent's job is to add judgment:

- Learning phase? New campaigns (< 7 days) classified as "reduce" or "pause" may need protection.
- Scale recommendations — suggest budget increases proportional to outperformance: 15-20% for adsets 20-40% above target, 25-40% for adsets >40% above. Cap at 50% per adjustment to avoid destabilizing Meta's learning algorithm.
- Pause recommendations — check if the adset is the only one in its campaign before recommending pause.
- Cross-objective context: check campaign names for explicit funnel indicators (e.g., "TOFU", "Retargeting", "Remarketing") before inferring cross-objective relationships. A traffic campaign feeding into a sales funnel may deserve more patience even if its own CPC is high.

Use `references/thresholds.md` interpretation rules for nuance.

### 6. Funnel Analysis

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

Connect bottlenecks to specific campaign or adset recommendations from Step 5.

### 7. Trend Analysis

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

### 8. Creative Analysis

Read `creative-analysis.json` from the run directory. This is the highest-value analysis step — where agent intelligence matters most. Do not skip or abbreviate any sub-step.

If an objective has 0 ads (empty winners/losers arrays), note this and explain why — typically the objective's adsets fell below the min_spend threshold. Do not fabricate analysis for empty data.

Contains per-objective sections. Each has winners (ranked by objective-appropriate metric), losers, and zero-conversion ads. Each includes `creative_body` and `creative_title` — the actual ad copy text.

For awareness, zero_conversion means zero video views. For reach-only awareness campaigns (no video), all ads will have conversions — focus on CPM comparison instead.

For traffic, winners are ranked by CTR. Cross-reference CPC — high CTR with high CPC may indicate a targeting or placement issue, not a true winner.

For the primary objective (and any other objective with >=5% of total spend):

1. Classify each winner's copy using the Four Horsemen framework from `references/brand-copy.md` (Money/Time/Status/Fear). Focus on the top 5 winners to prevent context bloat on accounts with high `top_n`. State which lever each winning ad pulls and why. If creative_body is empty (video-only ad), note this — it's a signal that video outperforms static copy.

2. Compare messaging angles: what do winners have in common that losers lack? Look for patterns in specificity vs vagueness, emotional vs rational tone, sentence length, use of numbers, opening hooks. Quote specific copy from winners and losers to illustrate.

3. Flag zero-conversion ads with their total wasted spend. These are budget leaks — recommend pause or replacement with a winning angle. Note which objective each belongs to.

4. If `~/.meta-ads-intel/creatives/manifest.json` exists (visual artifacts were extracted by the pipeline), read the manifest and then read 2-3 winner frames and 2-3 loser frames via Read tool. Compare visual patterns: opening hooks, text overlays, color palettes, product visibility, video pacing. If manifest doesn't exist, note that visual analysis was skipped (ffmpeg not installed).

5. Synthesize: which creative directions should be scaled (new variants in the same angle), which should be killed, and which of the Four Horsemen (Money/Time/Status/Fear) are absent from the current creative set? Recommend testing the missing angles with specific copy direction tied to the brand context. Note which objective each recommendation applies to.

6. If ad entries include diagnostic ranking fields (`quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking` — values like `ABOVE_AVERAGE_35`, `AVERAGE`, `BELOW_AVERAGE_35`, `UNKNOWN`, or empty string), cross-reference diagnostics with metric rankings:
   - First, report diagnostic coverage: "Diagnostics available for N of M ads (X%)." This sets expectations for how much of the analysis can be diagnostic-informed.
   - Winner + low quality_ranking (`BELOW_AVERAGE_35` or `BELOW_AVERAGE_10`): targeting is carrying weak creative — recommend creative refresh while keeping targeting settings
   - Loser + high quality_ranking (`ABOVE_AVERAGE_35` or `ABOVE_AVERAGE_20`): good creative stuck in bad targeting or funnel — investigate audience/landing page before killing the ad
   - Cross-run diagnostic comparison (all three rankings declining on a high-spend ad): only possible when a prior `data-*.json` report contains ad-level diagnostic rankings for the same ad IDs. On first runs or when prior data lacks ad-level diagnostics, skip this check and note the limitation.
   - `UNKNOWN`/empty on ads with <500 impressions: insufficient data, rely on metric rankings alone
   - `UNKNOWN`/empty on ads with 500-999 impressions: ambiguous — do not make causal claims about relevance
   - `UNKNOWN`/empty on ads with >=1000 impressions: likely placement or ad-type ineligibility (e.g., certain placements don't receive diagnostics), not data insufficiency. Flag these anomalies — they may indicate the ad is running primarily on placements where Meta cannot compute relevance scores.
   - If all ads have UNKNOWN/empty diagnostics across all three fields (but fields are present), note "Diagnostics are universally unavailable — this may indicate account-level ineligibility for relevance scoring" and skip per-ad diagnostic cross-referencing.
   - Partial diagnostics (e.g., quality_ranking present but engagement/conversion UNKNOWN): common for non-conversion objectives like Traffic or Awareness. Note which fields are available and analyze only those; do not treat missing fields as negative signals.
   - If diagnostic fields are absent from all entries (older pipeline version), skip this sub-step

### 9. Decision Brief

**Cross-run comparison**: Before synthesizing, check for previous report data. If `~/.meta-ads-intel/reports/data-*.json` files exist from earlier runs, read the file with the second-most-recent timestamp (the current run's file is written in Step 10 after the brief). Compare `primary_kpis` fields matching the primary objective and compute deltas (e.g., CPA change, ROAS change since last analysis). Include a "vs. Last Analysis" line in Account Health.

If the account has zero total spend in the analysis period, focus the brief on setup recommendations (create campaigns, define audiences, upload creatives). Do not synthesize empty data into action items.

Synthesize all analysis into:

- Account Health: total spend, per-objective spend breakdown, primary objective KPIs vs targets (+ vs. last analysis if available)
- Trends: period vs recent scorecard per objective, biggest movers
- Meta Opportunity Score: if recommendations.json was read in Step 4, include the score and note whether Meta's top recommendations align with or contradict our analysis
- Meta Recommendations Cross-Reference: group Step 4 recommendations into (1) confirms our analysis — recommendation supports the same action direction implied by KPI evidence, (2) surfaces new issues — no existing Step 5-8 finding covers this, (3) conflicts — Meta recommends the opposite action from KPI evidence. Incorporate API-Apply-supported recommendations where they align as quick wins.
- Top 3 Actions: highest-leverage changes with specific budget amounts and expected impact. Prioritize the primary objective but include cross-objective synergies where campaign names or funnel structure confirm relationships.
- Risks: fatigue signals, underperforming spend, drifting campaigns across all objectives. Flag any Meta recommendations that conflict with our own analysis as investigation items.
- Creative Insights: messaging/visual patterns correlating with performance, organized by objective
- Watch Items: learning-phase campaigns, insufficient-data tests

If only one objective is present, omit cross-objective synergy language.

### 10. Save Output

Write to `~/.meta-ads-intel/reports/`:
1. `report-{YYYY-MM-DD_HHMM}.md` — full markdown brief
2. `data-{YYYY-MM-DD_HHMM}.json` — structured JSON following this exact schema:

```json
{
  "date": "YYYY-MM-DD",
  "date_preset": "last_14d",
  "primary_objective": "OUTCOME_*",
  "total_spend": N,
  "primary_kpis": {
    "OUTCOME_SALES": {"cpa": N, "roas": N},
    "OUTCOME_TRAFFIC": {"cpc": N, "ctr": N}
  },
  "opportunity_score": N | null,
  "recommendations_count": N,
  "budget_actions_summary": {"scale": N, "reduce": N, "pause": N, "refresh": N, "maintain": N},
  "creative_summary": {"winners_count": N, "losers_count": N, "zero_conv_count": N, "zero_conv_spend": N}
}
```

Only include objectives present in `primary_kpis`. Use the `HHMM` timestamp from the pipeline run directory to match filenames (avoids same-day overwrites).

Return concise summary: account health headline, top 3 actions, report paths.

If this is the user's first analysis, suggest weekly scheduling: "For automated weekly analysis, set up a system scheduler. On macOS: a launchd plist at `~/Library/LaunchAgents/com.meta-ads-intel.weekly.plist` that runs `claude -p '/meta-ads-intel'`. On Linux: a crontab entry. Requires Claude Code CLI on PATH." Offer to create the plist/crontab if the user is interested.

## Rules

- NEVER read files in `_raw/` directories. These contain verbose API responses with 40+ duplicate action types per row.
- NEVER read `*-summary.json` files directly. These are intermediate pipeline files.
- NEVER read `creative-media.json` — it is consumed internally by the pipeline.
- Only read the 6 agent-facing analysis files: `account-health.json`, `budget-actions.json`, `funnel.json`, `trends.json`, `creative-analysis.json`, `recommendations.json`. The 7th file (`creative-media.json`) is consumed internally by the pipeline. `recommendations.json` may not always be present — check `files_produced` before reading. Also read `~/.meta-ads-intel/creatives/manifest.json` and selected frames when visual artifacts exist.
- All monetary values in analysis files are in the account's currency (not minor units — the pipeline already converts).
