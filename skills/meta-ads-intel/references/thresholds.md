# Budget Classification Rules & Interpretation Guide

Machine-readable config (account ID, targets, analysis params) lives in `~/.meta-ads-intel/config.json`. This file contains the interpretation rules the agent uses when reviewing budget-actions.json classifications.

## Budget Classification Rules

Applied to each adset with spend above min_spend threshold. Classification is per-objective — each objective uses its own KPIs and targets.

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
Primary KPIs: CPM. Optional secondary: CPV (for VIDEO_VIEWS campaigns). Targets from `targets.OUTCOME_AWARENESS.{cpm, max_frequency}`.
- Scale: CPM < target x 0.8
- Maintain: within 20% of target CPM
- Reduce: CPM > target x 1.2
- Pause: zero impressions (rare)
- Refresh threshold: uses awareness-specific max_frequency (typically lower, e.g., 3.0)
- CPV (cost per view): optional secondary KPI for VIDEO_VIEWS campaigns. Computed by `intel defaults` and offered as an optional target during onboarding. If `cpv` target is set in config, also evaluate CPV thresholds alongside CPM. If no CPV target is set, CPM-only classification applies.

### OUTCOME_ENGAGEMENT
Primary KPIs: CPE. Targets from `targets.OUTCOME_ENGAGEMENT.{cpe}`. Note: `engagement_rate` (post_engagement/impressions) is computed at analysis time for reporting — it is not a config target.
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

The pipeline normalizes legacy objectives to OUTCOME_* equivalents via `references/objective-map.json` (single source of truth). Key mappings: LINK_CLICKS -> OUTCOME_TRAFFIC, CONVERSIONS/PRODUCT_CATALOG_SALES -> OUTCOME_SALES, BRAND_AWARENESS/REACH/VIDEO_VIEWS -> OUTCOME_AWARENESS, POST_ENGAGEMENT/PAGE_LIKES/MESSAGES -> OUTCOME_ENGAGEMENT, LEAD_GENERATION -> OUTCOME_LEADS, APP_INSTALLS -> OUTCOME_APP_PROMOTION.

## Interpretation Notes

- TOFU campaigns naturally have higher CPA — weight recommendations accordingly. A TOFU campaign classified as "reduce" may still be strategically valuable for pipeline building.
- BOFU retargeting should have lower CPA and higher ROAS than TOFU. A BOFU campaign classified as "maintain" when it should be "scale" is a missed opportunity.
- New campaigns (< 7 days) may be in learning phase — flag but don't recommend pausing. Meta's algorithm needs ~50 conversions to exit learning phase.
- Budget values from the API are in minor currency units (cents/paisa) — divide by 100 for display. Note: analysis files produced by the pipeline are already converted to display units; do not double-convert.
- The "refresh" classification means the creative or audience is fatigued, not that the campaign strategy is wrong. Recommend new creative variants or audience expansion, not budget cuts.
- Cross-objective context: traffic campaigns feed awareness and sales funnels. Evaluate traffic CPC alongside downstream conversion rates, not in isolation.
- Awareness campaigns with low CPM but high frequency may be saturating audiences — check frequency trend even when CPM is on target.
- Trends use subtraction (full - recent = prior). Delayed attribution can cause recent conversions from prior-window clicks, slightly inflating recent ROAS/CPA.

## Funnel Expected Rates

Configurable in `config.json` under `funnel_expected_rates`. These are general e-commerce benchmarks — industry defaults. If not set in config, the pipeline uses these hardcoded fallbacks.

### OUTCOME_SALES (full 7-stage purchase funnel)
- Click rate (impression → click): 3.0%
- Landing rate (click → landing page): 70.0%
- Add to cart rate (landing → cart): 8.0%
- Cart to checkout: 50.0%
- Checkout to purchase: 60.0%

### OUTCOME_TRAFFIC (3-stage)
- Click rate: 1.5%
- Landing rate: 70.0%

### OUTCOME_ENGAGEMENT (3-stage)
- Engagement rate (impression → engagement): 2.0%
- Deep engagement rate (engagement → page engagement): 15.0%

### OUTCOME_LEADS (4-stage)
- Click rate: 2.0%
- Landing rate: 60.0%
- Lead conversion rate: 5.0%

### OUTCOME_APP_PROMOTION (3-stage)
- Click rate: 1.5%
- Install rate: 5.0%

### Market-specific notes
- Indian market may need lower BOFU rates (35-45% cart-to-checkout, 40-50% checkout-to-purchase) due to COD prevalence and payment friction.
- Instagram traffic may need lower landing rates (30-50%) due to in-app browsing behavior reducing clickthrough to external pages.
