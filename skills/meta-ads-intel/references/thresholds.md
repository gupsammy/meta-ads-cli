# Performance Targets & Configuration

## Account

- Account ID: YOUR_ACCOUNT_ID (e.g., act_123456789)
- Account Name: YOUR_ACCOUNT_NAME
- Currency: YOUR_CURRENCY (e.g., USD, EUR, INR, GBP)
- CLI Path: meta-ads

Override via environment variables: META_ADS_ACCOUNT_ID, META_ADS_CLI, META_ADS_DATA_DIR.

## Performance Targets

Set based on your account's margins and business goals:

- Target CPA: 0 (cost per purchase — set to your breakeven or target acquisition cost)
- Target ROAS: 0 (return on ad spend — e.g., 3.0 means $1 spent returns $3 revenue)
- Max Frequency: 5.0 (above this = audience saturation)
- Min Spend Threshold: 0 (minimum spend to include entity in recommendations — filters noise)

## Campaign Objective Rules

- OUTCOME_SALES: evaluate by CPA and ROAS against targets
- LINK_CLICKS: evaluate by CPC (set target) and CTR (target > 2.0%)
- OUTCOME_TRAFFIC: evaluate by landing_page_view cost and CTR
- OUTCOME_AWARENESS: evaluate by CPM and reach efficiency

## Budget Classification Rules

- Scale: ROAS > target * 1.2 AND CPA < target * 0.8
- Maintain: within 20% of targets
- Reduce: missing targets by >20%
- Pause: zero purchases AND spend > min threshold
- Refresh: frequency > max frequency ceiling

## Notes

- TOFU campaigns naturally have higher CPA — weight recommendations accordingly
- BOFU retargeting should have lower CPA and higher ROAS than TOFU
- New campaigns (< 7 days) may be in learning phase — flag but don't recommend pausing
- Budget values from the API are in minor currency units (cents/paisa) — divide by 100 for display
