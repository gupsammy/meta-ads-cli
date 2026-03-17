# First-Run Onboarding

Triggered when Step 0 detects no `~/.meta-ads-intel/config.json`. Three phases: install, configure, write config.

When asking questions: use AskUserQuestion tool if available. Otherwise, ask conversationally.

## Phase 1: Install & Setup

Check CLI:
```bash
which meta-ads && meta-ads --version
```

If not found — install globally (scripts require `meta-ads` on PATH, npx is not sufficient):
```bash
npm i -g meta-ads
```

If npm fails with permissions: suggest `sudo npm i -g meta-ads` or recommend nvm.

Run interactive setup (handles auth, token exchange, account selection):
```bash
meta-ads setup
```

Verify:
```bash
meta-ads auth status -o json
```

Check jq:
```bash
which jq
```
If missing: `brew install jq` (macOS) or `apt install jq` (Linux).

## Phase 2: Skill Configuration

Read account from CLI config:
```bash
jq -r '.defaults.account_id' ~/.config/meta-ads-cli/config.json
```

Fetch account name and currency:
```bash
meta-ads accounts get --account-id <account_id> -o json
```

Get current performance for smart threshold defaults (~50 tokens, not 5K):
```bash
bash <skill-dir>/scripts/compute-defaults.sh <account_id>
```
`<skill-dir>` is the directory containing this file's parent SKILL.md. Resolve from file path at runtime.

Output is `{"spend": N, "purchases": N, "revenue": N, "roas": N, "current_cpa": N, "current_roas": N}`.

Ask user for targets, providing current performance as context. Batch into one AskUserQuestion when possible:

1. Target CPA — "Your current average CPA is [current_cpa]. What is your target CPA (breakeven or goal acquisition cost)?"
2. Target ROAS — "Your current blended ROAS is [current_roas]. What is your target ROAS?"
3. Max Frequency — "Default is 5.0 (above this = audience saturation). Keep default or adjust?"
4. Min Spend Threshold — "Minimum spend to include an ad set in recommendations. Filters noise." Suggest sensible default based on currency (1000 for INR, 10 for USD/EUR).

Ask for brand context (for creative analysis). If project memory or prior context provides product/audience info, confirm rather than re-asking:
- Product/service description
- Price range
- Target audience
- Website URL (optional — for copy framework context)

## Phase 3: Write Config

Write `~/.meta-ads-intel/config.json`:
```json
{
  "account_id": "<account_id>",
  "account_name": "<name>",
  "currency": "<currency>",
  "targets": {
    "cpa": <user_target>,
    "roas": <user_target>,
    "max_frequency": <user_target>,
    "min_spend": <user_target>
  },
  "analysis": {
    "top_n": 15,
    "bottom_n": 10,
    "zero_purchase_n": 10
  }
}
```

Update `references/brand-copy.md` — replace the "Your Brand Context" placeholders with product, price, audience, and any proven hook angles from the compute-defaults data.

Create data directories:
```bash
mkdir -p ~/.meta-ads-intel/data ~/.meta-ads-intel/reports ~/.meta-ads-intel/creatives
```

Print summary:
- Account: [name] ([id])
- Currency: [currency]
- Targets: CPA [X], ROAS [X], Frequency [X], Min Spend [X]

Tell the user: "Setup complete. Proceeding with your first analysis."

Continue to Step 1 of the main SKILL.md process.
