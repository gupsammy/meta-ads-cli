# Budget Classification Rules & Interpretation Guide

Machine-readable config (account ID, targets, analysis params) lives in `~/.meta-ads-intel/config.json`. This file contains the interpretation rules the agent uses when reviewing budget-actions.json classifications.

## Budget Classification Rules

Applied by `prepare-analysis.sh` to each adset with spend above min_spend threshold. Classification is per-objective — each objective uses its own KPIs and targets.

### Universal rules (all objectives)
- Refresh: frequency > max frequency ceiling — audience saturation, needs new creative or audience
- Min spend filter: adsets below `targets.global.min_spend` are excluded from classification

### OUTCOME_SALES
Primary KPIs: CPA, ROAS. Targets from `targets.OUTCOME_SALES.{cpa, roas}`.
- Scale: ROAS > target x 1.2 AND CPA < target x 0.8
- Maintain: within 20% of targets on both axes
- Reduce: ROAS < target x 0.8 OR CPA > target x 1.2
- Pause: zero purchases despite spend above threshold

### OUTCOME_TRAFFIC
Primary KPIs: CPC, CTR. Targets from `targets.OUTCOME_TRAFFIC.{cpc, ctr}`.
- Scale: CPC < target x 0.8 AND CTR > target x 1.2
- Maintain: within 20% of targets
- Reduce: CPC > target x 1.2 OR CTR < target x 0.8
- Pause: zero link clicks despite spend

### OUTCOME_AWARENESS
Primary KPIs: CPM, CPV (for video campaigns). Targets from `targets.OUTCOME_AWARENESS.{cpm, cpv, max_frequency}`.
- Scale: CPM < target x 0.8 (or CPV < target x 0.8 for video campaigns when no CPM target)
- Maintain: within 20% of target CPM or CPV
- Reduce: CPM > target x 1.2 (or CPV > target x 1.2 for video campaigns when no CPM target)
- Pause: zero impressions (rare)
- Refresh threshold: uses awareness-specific max_frequency (typically lower, e.g., 3.0)
- CPV (cost per view): evaluated as secondary KPI when CPM target is not set but CPV target exists. VIDEO_VIEWS campaigns get credit for view efficiency via this path.

### OUTCOME_ENGAGEMENT
Primary KPIs: CPE. Targets from `targets.OUTCOME_ENGAGEMENT.{cpe, engagement_rate}`.
- Scale: CPE < target x 0.8
- Maintain: within 20% of target CPE
- Reduce: CPE > target x 1.2
- Pause: zero post_engagement despite spend

### OUTCOME_LEADS
Primary KPIs: CPL. Targets from `targets.OUTCOME_LEADS.{cpl}`.
- Scale: CPL < target x 0.8
- Maintain: within 20% of target CPL
- Reduce: CPL > target x 1.2
- Pause: zero leads despite spend

### OUTCOME_APP_PROMOTION
Primary KPIs: CPI. Targets from `targets.OUTCOME_APP_PROMOTION.{cpi}`.
- Scale: CPI < target x 0.8
- Maintain: within 20% of target CPI
- Reduce: CPI > target x 1.2
- Pause: zero installs despite spend

## Legacy Objective Normalization

Scripts normalize legacy objectives to OUTCOME_* equivalents via `references/objective-map.json` (single source of truth). Key mappings: LINK_CLICKS -> OUTCOME_TRAFFIC, CONVERSIONS/PRODUCT_CATALOG_SALES -> OUTCOME_SALES, BRAND_AWARENESS/REACH/VIDEO_VIEWS -> OUTCOME_AWARENESS, POST_ENGAGEMENT/PAGE_LIKES/MESSAGES -> OUTCOME_ENGAGEMENT, LEAD_GENERATION -> OUTCOME_LEADS, APP_INSTALLS -> OUTCOME_APP_PROMOTION.

## Interpretation Notes

- TOFU campaigns naturally have higher CPA — weight recommendations accordingly. A TOFU campaign classified as "reduce" may still be strategically valuable for pipeline building.
- BOFU retargeting should have lower CPA and higher ROAS than TOFU. A BOFU campaign classified as "maintain" when it should be "scale" is a missed opportunity.
- New campaigns (< 7 days) may be in learning phase — flag but don't recommend pausing. Meta's algorithm needs ~50 conversions to exit learning phase.
- Budget values from the API are in minor currency units (cents/paisa) — divide by 100 for display. Note: analysis files produced by prepare-analysis.sh are already converted to display units; do not double-convert.
- The "refresh" classification means the creative or audience is fatigued, not that the campaign strategy is wrong. Recommend new creative variants or audience expansion, not budget cuts.
- Cross-objective context: traffic campaigns feed awareness and sales funnels. Evaluate traffic CPC alongside downstream conversion rates, not in isolation.
- Awareness campaigns with low CPM but high frequency may be saturating audiences — check frequency trend even when CPM is on target.
