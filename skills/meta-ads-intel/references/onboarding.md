# First-Run Onboarding

This guide is loaded when Step 0 detects unconfigured state. Walk the user through each phase sequentially. Skip phases that are already satisfied.

When asking questions: use the AskUserQuestion tool if available. Otherwise, ask conversationally and wait for the user's response.

## Phase 1: Install meta-ads CLI

Check if `meta-ads` is on PATH:
```bash
which meta-ads && meta-ads --version
```

If not found, install it:
```bash
npm i -g meta-ads
```

If npm is unavailable, tell the user they can use `npx meta-ads` as an alternative (each command prefixed with `npx`). Verify installation:
```bash
meta-ads --version
```

Also verify `jq` is installed (`which jq`). If missing, tell the user to install it (`brew install jq` on macOS, `apt install jq` on Linux).

## Phase 2: Authentication

Check existing auth:
```bash
meta-ads auth status -o json
```

If authenticated (token present), show the masked token and skip to Phase 3.

If not authenticated:

1. Tell the user they need a Meta access token with `ads_read` and `ads_management` permissions.
2. Direct them to the Graph API Explorer: https://developers.facebook.com/tools/explorer/
3. Instruct them to:
   - Select their app (or use "Meta App" default)
   - Click "Generate Access Token"
   - Under Permissions, add: `ads_read`, `ads_management`
   - Copy the generated token
4. Ask the user to paste their token.
5. Authenticate using the environment variable approach (preferred — avoids exposing the token in shell history):
```bash
export META_ADS_ACCESS_TOKEN=<pasted_token>
meta-ads auth status -o json
```
Alternatively, save the token persistently (note: this writes the token to shell history):
```bash
meta-ads auth login --token <pasted_token>
```
6. Verify and check token longevity:
```bash
meta-ads auth status -o json
```
7. If the token is short-lived (< 24h expiry), warn the user and suggest exchanging it for a long-lived token via their app settings, or note they will need to re-authenticate periodically.

## Phase 3: Auto-Fetch Account Info

Fetch the user's ad accounts:
```bash
meta-ads accounts list -o json
```

If multiple accounts are returned, present a numbered list and ask the user which account to configure. If only one account, use it automatically.

From the selected account, extract:
- Account ID (e.g., `act_123456789`)
- Account Name
- Currency (e.g., USD, EUR, INR)

Also fetch active campaigns to get a baseline:
```bash
meta-ads campaigns list --account-id <account_id> --status ACTIVE -o json
```

Note the number of active campaigns and their objectives for context.

## Phase 4: Auto-Fetch Brand Context

Ask the user: "What is your website or store URL? (optional — press Enter to skip)"

If the user provides a URL:
- Fetch the page and extract: product descriptions, price range, target audience signals, brand voice/tone.
- Use this to populate the "Your Brand Context" section of `brand-copy.md`.

Regardless of website, fetch ad performance and creative content separately (the insights endpoint returns metrics but not creative fields):

First, get ad-level performance metrics:
```bash
meta-ads insights get --account-id <account_id> --date-preset last_30d --level ad -o json
```

Then, fetch creative content (body, title, image URL) for ads in the account:
```bash
meta-ads ads list --account-id <account_id> -o json
```

Join the two datasets by `ad_id`. Identify the top 3 ads by ROAS (or by lowest CPA if ROAS is unavailable) and extract their `creative_body` and `creative_title` to identify proven hook angles and winning formats.

Also identify the bottom 3 performers to note weak formats.

Use this data to auto-fill the brand context:
- Product: from website or inferred from ad creative copy
- Price point: from website or ask user
- Audience: from website or inferred from targeting/copy
- Proven hook angles: from top-performing ad copy
- Winning format: from top performers' creative type
- Weak format: from bottom performers' creative type

If the website was skipped and product/price/audience can't be reliably inferred from ad copy, ask the user directly for:
- What product or service do you sell?
- What is your price range?
- Who is your target audience?

## Phase 5: Ask User for Thresholds

These depend on business margins and cannot be auto-detected. Fetch current performance to suggest smart defaults:

From the insights data already pulled (or pull if not yet available):
```bash
meta-ads insights get --account-id <account_id> --date-preset last_30d --level account -o json
```

Calculate current average CPA and blended ROAS from the account-level data.

Ask the user for each threshold, providing their current performance as context:

1. Target CPA: "Your current average CPA is [X]. What is your target CPA (breakeven or goal acquisition cost)?"
2. Target ROAS: "Your current blended ROAS is [X]. What is your target ROAS? (e.g., 3.0 means $1 spent returns $3)"
3. Max Frequency: "Default is 5.0 (ads shown more than this per person indicate audience saturation). Want to keep the default or adjust?"
4. Min Spend Threshold: "What minimum spend should an ad set have before it's included in recommendations? This filters out noise from low-spend entities." Suggest a sensible default based on currency (e.g., 500 for INR, 10 for USD, 10 for EUR).

## Phase 6: Write Configuration

Update `references/thresholds.md` — replace all placeholder values:
- `YOUR_ACCOUNT_ID` with the actual account ID
- `YOUR_ACCOUNT_NAME` with the actual account name
- `YOUR_CURRENCY` with the actual currency
- Target CPA `0` with the user's target
- Target ROAS `0` with the user's target
- Min Spend Threshold `0` with the user's chosen value
- Max Frequency `5.0` — update only if user changed it

Update `references/brand-copy.md` — replace the "Your Brand Context" placeholders:
- `YOUR_PRODUCT_DESCRIPTION` with product info (from website or user)
- `YOUR_PRICE_RANGE` with price info (from website or user)
- `YOUR_TARGET_AUDIENCE` with audience info (from website or user)
- Proven hook angles, winning format, weak format from ad performance data

Print a summary of what was configured:
- Account: [name] ([id])
- Currency: [currency]
- Targets: CPA [X], ROAS [X], Frequency [X], Min Spend [X]
- Brand context: [filled/skipped]
- Active campaigns: [count]

Tell the user: "Setup complete. Proceeding with your first analysis."

Continue to Step 1 of the main SKILL.md process.
