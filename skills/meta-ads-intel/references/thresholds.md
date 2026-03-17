# Budget Classification Rules & Interpretation Guide

Machine-readable config (account ID, targets, analysis params) lives in `~/.meta-ads-intel/config.json`. This file contains the interpretation rules the agent uses when reviewing budget-actions.json classifications.

## Budget Classification Rules

Applied by `prepare-analysis.sh` to each adset with spend above min_spend threshold:

- Scale: ROAS > target × 1.2 AND CPA < target × 0.8 — strong performer, increase budget
- Maintain: within 20% of targets — performing acceptably, hold steady
- Reduce: missing targets by >20% on ROAS or CPA — underperforming, decrease budget
- Pause: zero purchases AND spend > min threshold — no conversions despite spend
- Refresh: frequency > max frequency ceiling — audience saturation, needs new creative or audience

## Campaign Objective Rules

Classification targets vary by campaign objective:

- OUTCOME_SALES: evaluate by CPA and ROAS against targets (primary use case)
- LINK_CLICKS: evaluate by CPC and CTR (target CTR > 2.0%)
- OUTCOME_TRAFFIC: evaluate by landing_page_view cost and CTR
- OUTCOME_AWARENESS: evaluate by CPM and reach efficiency

## Interpretation Notes

- TOFU campaigns naturally have higher CPA — weight recommendations accordingly. A TOFU campaign classified as "reduce" may still be strategically valuable for pipeline building.
- BOFU retargeting should have lower CPA and higher ROAS than TOFU. A BOFU campaign classified as "maintain" when it should be "scale" is a missed opportunity.
- New campaigns (< 7 days) may be in learning phase — flag but don't recommend pausing. Meta's algorithm needs ~50 conversions to exit learning phase.
- Budget values from the API are in minor currency units (cents/paisa) — divide by 100 for display.
- The "refresh" classification means the creative or audience is fatigued, not that the campaign strategy is wrong. Recommend new creative variants or audience expansion, not budget cuts.
