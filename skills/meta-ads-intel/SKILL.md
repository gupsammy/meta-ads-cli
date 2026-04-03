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
argument-hint: "[date-preset | reconfigure]"
metadata:
  author: gupsammy
  version: "3.2"
---

# Meta Ads Intelligence

Analyze Meta Ads campaign data and produce actionable intelligence: budget optimization, creative performance rankings, trend analysis, funnel diagnostics, and a strategic decision brief. Supports all campaign objectives (Sales, Traffic, Awareness, Engagement, Leads, App Promotion) with per-objective KPIs.

Arguments: `$ARGUMENTS` — optional date preset (default: last_14d). Valid: last_7d, last_14d, last_30d, last_90d, this_month, last_month.

## Data Architecture

The CLI handles all data pulling, summarization, and computation. The pipeline produces 9 output files; the agent reads 8 directly (creative-media.json is consumed internally by the pipeline for visual artifact extraction). All analysis files are objective-aware: data is grouped by campaign objective with per-objective KPIs and classifications.

```
~/.meta-ads-intel/
├── config.json          # account + per-objective targets + analysis params (v2)
├── brand-context.md     # product, audience, hooks (created by onboarding)
├── data/
│   └── YYYY-MM-DD_HHMM/ # timestamped run (never overwritten)
│       ├── _raw/          # raw API responses — NEVER read these
│       ├── _summaries/    # intermediate summaries — NEVER read these
│       ├── _recent/       # recent window summaries (for trends)
│       ├── account-health.json     ── agent reads these 8 ──
│       ├── budget-actions.json
│       ├── funnel.json
│       ├── trends.json
│       ├── creative-analysis.json
│       ├── fatigue.json              # may be absent (daily data needed)
│       ├── report.json               # pre-computed summary for brief
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
Read `references/brand-copy.md` for copy psychology framework (Four Horsemen, copy specs, forbidden words). Read `~/.meta-ads-intel/brand-context.md` for user's brand context (product, audience, proven hooks). This file is created during onboarding and must exist in analysis mode. If brand-context.md is missing, warn the user and suggest `/meta-ads-intel reconfigure` to recreate it. Proceed with analysis but note "Creative analysis limited — brand context not available" in the brief.

### 2. Run Analysis Pipeline

```bash
meta-ads intel run $ARGUMENTS -o json
```

This command runs the full pipeline: pull raw API data → summarize → compute 9 analysis files → extract visual creative artifacts (if ffmpeg available).

If ffmpeg is not available, the command logs a note to stderr. Note this in the analysis — visual creative analysis was skipped, and the user can install ffmpeg (`brew install ffmpeg`) for future runs.

If the command fails (auth expired, network, missing account), report error and stop.

The command outputs JSON to stdout:
```json
{"run_dir": "...", "status": "complete|partial", "files_produced": [...], "files_skipped": [...], "warnings": [...], "creatives": {"total_ads": N, "total_frames": N}}
```
The `creatives` field is present only when ffmpeg extracted visual artifacts.

Read `run_dir` from the output — all subsequent reads come from this directory. If `status` is `"partial"`, check `files_skipped` and `warnings` — report missing data to the user before proceeding. Only read files listed in `files_produced`. Proceed with analysis for all produced files. For each step that requires a missing file, skip that step and note "Skipped: [filename] not produced" in the decision brief. Never abort the full analysis because one file is missing.

If warnings mention truncation or data limits, note this prominently in Step 10: "Analysis covers a capped sample of ads. Rankings reflect the pipeline's top/bottom selection, not the full ad set."

### 3. Account Health

Read `account-health.json` from the run directory.

This contains per-objective sections keyed by objective name (e.g., `OUTCOME_SALES`, `OUTCOME_TRAFFIC`). If legacy objective names appear (e.g., `CONVERSIONS`, `LINK_CLICKS`), consult `references/objective-map.json` to map them to modern OUTCOME_* keys. Each section has its own KPIs and target comparisons. The `primary_objective` field indicates which objective gets the most weight in the scorecard.

For each objective present, read the pre-computed `*_vs_target` percentage fields (e.g., `cpa_vs_target`, `roas_vs_target`, `cpc_vs_target`). These are integer percentages: positive = above target, negative = below. Flag any where `abs(value) > 20`. Use `references/thresholds.md` for objective-specific interpretation rules. If `target_cpv` is present in config for Awareness campaigns, also evaluate CPV via `cpv_vs_target`.

Report `total_spend` and per-objective `spend_pct` (pre-computed percentage of total spend). Note: `total_reach` sums reach across objectives — users reached by multiple campaigns are counted once per campaign, so the total overstates unique reach. Lead with the primary objective's scorecard, then cover others.

### 4. Recommendations (Meta API) — LOW PRIORITY

Read `recommendations.json` from the run directory — only if listed in `files_produced`. If not produced, skip silently. Note `opportunity_score` for Step 3 context. Note top entries for cross-referencing in Step 10. Do not elevate above KPI-based analysis. Meta recommendations are self-serving and must never appear in Top 3 Actions.

### 5. Budget Actions

Read `budget-actions.json` from the run directory.

Per-objective sections, each pre-classified into scale/reduce/pause/refresh/bleeders/maintain buckets with reason strings. Each objective uses its own KPIs for classification (see `references/thresholds.md`). The agent's job is to add judgment:

- **Bleeders first**: Lead with the `bleeders` bucket — these are adsets with zero conversions despite spending above the min_spend threshold. They are the most urgent action items (money literally wasted). Report each bleeder's adset name, objective, spend, and reason. Recommend immediate pause. If bleeders make up >50% of evaluated adsets in an objective, escalate: this signals a campaign-level targeting or creative strategy problem, not individual adset issues — recommend reviewing the campaign's audience, creative, and offer before pausing everything.
- Learning phase? New campaigns (< 7 days) classified as "reduce" or "pause" may need protection. Also applies to bleeders — a new campaign with zero conversions in its first 3 days is not necessarily a bleeder, it may still be in the learning phase (~50 conversions needed to exit).
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

### 8. Creative Fatigue

Read `fatigue.json` from the run directory — only if listed in `files_produced`. If not produced, skip this step and note "Fatigue analysis skipped — daily ad-level data was not available for this run."

This file contains per-ad fatigue signals computed from daily metrics over the last 7 days. The pipeline tracks three signals per ad: `ctr_declining` (3+ consecutive daily CTR drops, >20% decline from peak), `cpc_rising` (3+ consecutive daily CPC increases, >15% rise from trough), and `frequency_high` (above the configured max_frequency ceiling).

Ads are bucketed into:
- `rotate`: Fatigued — both CTR declining and frequency high. Recommend immediate creative swap.
- `watch`: Early warning — CTR dipping but frequency still low, or mixed signals. Monitor 48 hours before acting.
- `healthy`: No fatigue signals detected (or insufficient data — fewer than 3 days tracked).

Report the summary counts (rotate/watch/healthy out of total_ads). Use `summary.by_campaign` for per-campaign breakdowns — these are pre-computed by the pipeline, do not count array entries manually. For each `rotate` entry, list the ad name, campaign, signals, spend, peak CTR vs latest CTR, and the decline percentage. For `watch` entries, list the top 3 by spend with their signals.

Cross-reference with Step 7 (Trends): if a campaign appears in both trend alerts (KPI deteriorating) and has rotate/watch counts > 0 in `summary.by_campaign`, this is a strong confirmation of creative exhaustion — call it out explicitly.

Cross-reference with Step 5 (Budget Actions): if an adset flagged as `refresh` (frequency > ceiling) also contains rotate-flagged ads, the fatigue signal is confirmed from two independent analyses.

**Fatigue override rule**: a `watch` item may be escalated to "pause" in the brief ONLY if it independently qualifies via another analysis — e.g., it also appears in the creative losers list with ROAS < 1.5x, or it is a zero-conversion ad. State the cross-reference explicitly when overriding.

### 9. Creative Analysis

Read `creative-analysis.json` from the run directory. This is the highest-value analysis step — where agent intelligence matters most. Do not skip or abbreviate any sub-step.

If an objective has 0 ads (empty winners/losers arrays), note this and explain why — typically the objective's adsets fell below the min_spend threshold. Do not fabricate analysis for empty data.

Contains per-objective sections. Each has winners (ranked by objective-appropriate metric), losers, and zero-conversion ads. Each includes `creative_body` and `creative_title` — the actual ad copy text.

For awareness, zero_conversion means zero video views. For reach-only awareness campaigns (no video), all ads will have conversions — focus on CPM comparison instead.

For traffic, winners are ranked by CTR. Cross-reference CPC — high CTR with high CPC may indicate a targeting or placement issue, not a true winner.

For the primary objective (and any other objective with `spend_pct >= 5` in account-health.json):

1. Read `overview.winner_stats` for each objective — this gives pre-computed counts of `total`, `empty_body`, `video`, and `image_only` winners. Use these numbers directly in prose; do not count array entries manually. If `empty_body` > 0, note that video-only ads (no body copy) are among the winners — this signals video outperforms static copy. Classify each winner's copy using the Four Horsemen framework from `references/brand-copy.md` (Money/Time/Status/Fear). Focus on the top 5 winners to prevent context bloat on accounts with high `top_n`. State which lever each winning ad pulls and why.

2. Compare messaging angles: what do winners have in common that losers lack? Look for patterns in specificity vs vagueness, emotional vs rational tone, sentence length, use of numbers, opening hooks. Quote specific copy from winners and losers to illustrate.

3. Flag zero-conversion ads with their total wasted spend. These are budget leaks — recommend pause or replacement with a winning angle. Include an Objective column in the zero-conversion table alongside ad name, campaign, spend, and impressions.

4. If `~/.meta-ads-intel/creatives/manifest.json` exists (visual artifacts were extracted by the pipeline), read the manifest and then read 2-3 winner frames and 2-3 loser frames via Read tool. Select frames by primary KPI rank — top 2-3 winners and bottom 2-3 losers. Prefer visual diversity (mix of video first-frames and static images) when ranks are close. Compare visual patterns: opening hooks, text overlays, color palettes, product visibility, video pacing. Weave visual observations into the winner/loser narrative rather than isolating them in a separate sub-section. If manifest doesn't exist, note that visual analysis was skipped (ffmpeg not installed).

5. **Same-name cross-campaign scan**: read `cross_campaign_names` from the top level of creative-analysis.json. This array is pre-computed by the pipeline — each entry contains the ad name, which campaign/objective it won in, and which it lost in. This pattern (same creative winning in one campaign, losing in another) is a high-signal targeting insight — it separates creative quality from audience quality. Flag every instance found.

6. Synthesize: which creative directions should be scaled (new variants in the same angle), which should be killed, and which of the Four Horsemen (Money/Time/Status/Fear) are absent from the current creative set? Recommend testing the missing angles with specific copy direction tied to the brand context. Note which objective each recommendation applies to.

7. Read pre-computed `diagnostic_status` on each ad entry and `diagnostic_coverage` from the overview. The pipeline classifies each ad as `available`, `insufficient_data`, `ambiguous`, `placement_ineligible`, or `partial` based on impression thresholds and ranking availability. Report coverage: "Diagnostics available for {diagnostic_coverage.available} of {diagnostic_coverage.total} ads ({diagnostic_coverage.pct}%)." If `diagnostic_coverage.account_ineligible` is true, note "Diagnostics are universally unavailable — this may indicate account-level ineligibility for relevance scoring" and skip per-ad diagnostic cross-referencing. Focus agent judgment on interpretation:
   - Winner + low quality_ranking (`BELOW_AVERAGE_35` or `BELOW_AVERAGE_10`): targeting is carrying weak creative — recommend creative refresh while keeping targeting settings
   - Loser + high quality_ranking (`ABOVE_AVERAGE_35` or `ABOVE_AVERAGE_20`): good creative stuck in bad targeting or funnel — investigate audience/landing page before killing the ad
   - `partial` status ads: note which fields are available and analyze only those; do not treat missing fields as negative signals

### 10. Decision Brief

**Pipeline summary scaffold**: Read `report.json` from the run directory. This contains pre-computed KPI snapshots, budget summaries (including bleeders), funnel bottlenecks, trend alerts, creative highlights, and auto-generated action items. Use this as the structural backbone — it ensures consistency between what the pipeline computed and what the brief reports. Layer agent judgment on top: copy psychology insights, cross-objective synergies, recommendation cross-referencing, and fatigue context that the pipeline cannot compute.

**Cross-run comparison**: Read `report.json` field `sections.cross_run_delta`. If non-null, the pipeline has pre-computed KPI deltas (`kpi_deltas`), fatigue comparison (`fatigue_delta`), and budget comparison (`budget_delta`) against the most recent prior `data-*.json` report. Use `kpi_deltas` to include a "vs. Last Analysis" column in the Account Health table (e.g., "CPA: 1,086 → 1,117, +2.9%"). If `fatigue_delta` shows more rotate-flagged ads than the prior run, escalate fatigue as a trend. If `cross_run_delta` is null, this is the first analysis — note "First analysis — no prior data for comparison."

All counts referenced in the brief (fatigue per campaign, winner composition, cross-campaign duplicates, budget action totals) are pre-computed in the JSON files. Read them directly from `report.json` sections `fatigue_by_campaign` and `creative_winner_stats`, and from `creative-analysis.json` field `cross_campaign_names`. Do not count array entries manually.

If the account has zero total spend in the analysis period, focus the brief on setup recommendations (create campaigns, define audiences, upload creatives). Do not synthesize empty data into action items.

Synthesize all analysis into:

- Account Health: total spend, per-objective spend breakdown, primary objective KPIs vs targets (+ vs. last analysis if available). Source from `report.json` `kpi_snapshot`.
- Budget Bleeders: if `report.json` `bleeders.count` > 0, call out total bleeding spend and list each bleeder. This is the most urgent section — money wasted with zero return.
- Trends: period vs recent scorecard per objective, biggest movers
- Creative Fatigue: if Step 8 found rotate-flagged ads, summarize here with concrete rotation recommendations. Cross-reference with trend alerts and refresh-classified adsets.
- Top 3 Actions: highest-leverage changes with specific budget amounts and expected impact. Derived ONLY from our own KPI-based analysis (Steps 5-9). Never include a Meta recommendation as a Top 3 Action. Prioritize the primary objective but include cross-objective synergies where campaign names or funnel structure confirm relationships. Bleeder pauses, fatigued creative rotations, and persistent funnel bottlenecks (checkout-to-purchase < 50% for 2+ consecutive analyses) should be weighted as high-leverage actions.
- Risks: fatigue signals, underperforming spend, drifting campaigns across all objectives.
- Meta Recommendations (supplementary): if recommendations.json was read in Step 4, include a brief low-priority section noting (1) which recommendations confirm our analysis, (2) which surface new ideas worth investigating, (3) which conflict with KPI evidence. Present these as "Meta suggests..." not as our recommendations. Meta recommendations are self-serving — never include them in Top 3 Actions. Do not let Meta's claimed impact percentages drive prioritization.
- Creative Insights: messaging/visual patterns correlating with performance, organized by objective
- Watch Items: learning-phase campaigns, insufficient-data tests, watch-flagged ads from fatigue analysis

If only one objective is present, omit cross-objective synergy language.

Present sections in this order. Consistent structure across runs allows quick comparison.

### 11. Save Output

1. Write `report-{YYYY-MM-DD_HHMM}.md` (full markdown brief) to `~/.meta-ads-intel/reports/`.
2. Verify `data-{HHMM}.json` exists in `~/.meta-ads-intel/reports/` — if missing, copy from run directory. Use the `HHMM` timestamp from the pipeline run directory to match filenames.
3. Return concise summary: account health headline, top 3 actions, both file paths.

If this is the user's first analysis, suggest weekly scheduling: "For automated weekly analysis, set up a system scheduler. On macOS: a launchd plist at `~/Library/LaunchAgents/com.meta-ads-intel.weekly.plist` that runs `claude -p '/meta-ads-intel'`. On Linux: a crontab entry. Requires Claude Code CLI on PATH." Offer to create the plist/crontab if the user is interested.

## Rules

- NEVER read files in `_raw/` directories. These contain verbose API responses with 40+ duplicate action types per row.
- NEVER read `*-summary.json` files directly. These are intermediate pipeline files.
- NEVER read `creative-media.json` — it is consumed internally by the pipeline.
- Only read the 8 agent-facing analysis files: `account-health.json`, `budget-actions.json`, `funnel.json`, `trends.json`, `creative-analysis.json`, `fatigue.json`, `report.json`, `recommendations.json`. The 9th file (`creative-media.json`) is consumed internally by the pipeline. `recommendations.json` and `fatigue.json` may not always be present — check `files_produced` before reading. Also read `~/.meta-ads-intel/creatives/manifest.json` and selected frames when visual artifacts exist.
- All monetary values in analysis files are in the account's currency (not minor units — the pipeline already converts).
