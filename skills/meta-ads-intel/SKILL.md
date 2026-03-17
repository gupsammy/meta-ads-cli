---
name: meta-ads-intel
description: >
  Analyze Meta (Facebook) Ads performance with budget optimization, creative
  analysis, trend detection, funnel diagnostics, and actionable recommendations.
  Use when user says "analyze my ads", "meta ads report", "campaign performance",
  "budget optimization", "creative analysis", "ads intelligence", "weekly ads brief",
  "ad account health", or wants performance insights from Meta advertising data.
  Not for creating/updating campaigns or writing ad copy.
license: MIT
compatibility: >
  Requires meta-ads CLI (npm i -g meta-ads), jq, and optionally ffmpeg/ffprobe
  for visual creative analysis. Node.js >= 20.
metadata:
  author: gupsammy
  version: "1.0"
---

# Meta Ads Intelligence

Analyze Meta Ads campaign data and produce actionable intelligence: budget optimization, creative performance rankings, trend analysis, funnel diagnostics, and a strategic decision brief.

Arguments: `$ARGUMENTS` — optional date preset (default: last_14d). Valid: last_7d, last_14d, last_30d, last_90d, this_month, last_month, this_week_mon_today.

## Setup

Data storage defaults to `/tmp/meta-ads-intel/` (cleared on reboot). For persistent data across sessions:
```bash
export META_ADS_DATA_DIR=~/.meta-ads-intel-data
```

## Process

### 0. First-Run Pre-Check

Before anything else, check if the skill is configured:

1. Check if `meta-ads` CLI is available: run `which meta-ads || npx meta-ads --version`
2. Check if `references/thresholds.md` contains the string `YOUR_ACCOUNT_ID`
3. Check if `references/brand-copy.md` contains the string `YOUR_PRODUCT_DESCRIPTION`

If all three pass (CLI exists, no placeholders found) — skip to Step 1.

If any check fails — read `references/onboarding.md` and follow that flow. The onboarding will install the CLI, authenticate, fetch account data, ask the user for thresholds, and auto-fill both config files. Once onboarding completes, continue to Step 1.

### 1. Load Configuration

Read `references/thresholds.md` for account ID, CLI path, performance targets, min thresholds.
Read `references/metrics.md` for field definitions and metric interpretation.
Read `references/brand-copy.md` for copy psychology framework and brand context. Use during Step 4 creative analysis.

### 2. Pull Fresh Data

```bash
bash <skill-dir>/scripts/pull-data.sh $ARGUMENTS
```
`<skill-dir>` is the directory containing this SKILL.md. Resolve it from this file's path at runtime.

If script fails (auth expired, network), report error and stop.

Read SUMMARY files from the data directory's `_period/` subdirectory:
- `campaigns-summary.json` — campaign metrics (spend, purchases, revenue, roas, cpa, funnel counts)
- `adsets-summary.json` — adset metrics with campaign context
- `ads-summary.json` — ad metrics with creative content (body, title, image_url)

Read `manifest.json` for available historical dates.

**CRITICAL: Never read raw campaigns.json, adsets.json, or ads.json. These contain 40+ duplicate action types per row. Always use *-summary.json variants.**

### 3. Budget Optimization

For each adset with spend above min threshold from thresholds.md:

1. Compare `cpa` and `roas` against targets.
2. Check `frequency` against ceiling (high frequency = audience saturation).
3. Account for campaign objective (OUTCOME_SALES vs LINK_CLICKS).

Classify each adset using the Budget Classification Rules in `references/thresholds.md`.

### 3.5. Period Comparison & Trend Analysis

**Period comparison (default).** The data pull automatically fetches both the requested period (`_period/`) and a recent 7-day window (`_recent/`) unless the user requested last_7d. When `_recent/` exists:

1. Read `_recent/campaigns-summary.json` and `_period/campaigns-summary.json`.
2. Match campaigns by `campaign_id`. Compute deltas between recent window and full period: spend rate (recent daily avg vs period daily avg), CPA change, ROAS change, frequency change.
3. Flag metrics that worsened by >15% in the recent window vs the full period.
4. Present as a "Recent vs Period" scorecard in the Decision Brief.

**Daily WoW comparison (when historical data exists).** Also check `manifest.json` for daily snapshots. If a date from ~7 days ago exists, compute week-over-week deltas and classify trends: improving/stable/declining.

No `_recent/` and no daily history → skip trend analysis, recommend `pull-data.sh --seed 7`.

### 4. Creative Performance

For each ad with spend above threshold:

1. Rank by ROAS within parent campaign.
2. Top 20% = winners, bottom 20% = losers.
3. Flag zero-purchase ads with significant spend.
4. Analyze `creative_body`, `creative_title` — what messaging angles win/lose.

### 4.5. Visual Creative Analysis

Write `creative-targets.json` with top 5 and bottom 5 ads by ROAS.

```bash
bash <skill-dir>/scripts/analyze-creatives.sh
```
`<skill-dir>` — same as Step 2.

Read extracted frames via Read tool. Compare visual patterns: hooks, text overlays, color palettes, product visibility across winners vs losers.

### 5. Funnel Analysis

Sum funnel counts from campaigns-summary: `view_content` → `add_to_cart` → `initiate_checkout` → `purchases`. Compute conversion rates between stages. Identify biggest drop-off:
- Low view_content/spend = targeting issue (TOFU)
- Low cart rate = product page issue (MOFU)
- Low checkout completion = payment/trust issue (BOFU)

### 6. Decision Brief

Synthesize into:
- **Account Health**: spend, purchases, blended CPA/ROAS vs targets
- **Trends**: WoW summary, biggest movers
- **Top 3 Actions**: highest-leverage changes with budget amounts and expected impact
- **Risks**: fatigue, underperforming spend, drifting campaigns
- **Creative Insights**: messaging/visual patterns correlating with performance
- **Watch Items**: learning-phase campaigns, insufficient-data tests

### 7. Save Output

Write to `~/.meta-ads-intel/`:
1. `report-{YYYY-MM-DD}.md` — full markdown brief
2. `data-{YYYY-MM-DD}.json` — structured JSON (summary, funnel, campaigns, adsets, top/bottom ads, visual analysis, recommendations)

Return concise summary: account health, top 3 actions, report paths.
