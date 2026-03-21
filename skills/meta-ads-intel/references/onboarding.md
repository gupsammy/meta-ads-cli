# First-Run Onboarding

Triggered when Step 0 detects no `~/.meta-ads-intel/config.json`. Six phases: install, account discovery, brand context, creative scan, target setting, write config.

Onboarding is its own session. Do NOT continue to analysis after onboarding completes. The user runs /meta-ads-intel again for their first analysis.

When asking questions: use AskUserQuestion tool if available. Otherwise, ask conversationally.

## Phase 1: Install & Setup

Check CLI and dependencies:
```bash
which meta-ads && meta-ads --version; which jq; which ffmpeg
```

If meta-ads not found — install globally (scripts require `meta-ads` on PATH, npx is not sufficient):
```bash
npm i -g meta-ads
```
If npm fails with permissions: suggest `sudo npm i -g meta-ads` or recommend nvm.

If jq missing: `brew install jq` (macOS) or `apt install jq` (Linux).
If ffmpeg missing: note "ffmpeg not installed — visual creative analysis will be skipped in future runs. Install with `brew install ffmpeg` when ready." NOT blocking.

### Authentication

Non-interactive shell environments cannot prompt for stdin — `meta-ads setup` without flags will fail. Use the non-interactive flow:

1. Ask the user for their Meta API access token (via AskUserQuestion).
2. Run setup with `--non-interactive`:
```bash
meta-ads setup --non-interactive --token "<token>" --skip-account
```
3. List accounts to find the right one:
```bash
meta-ads accounts list -o json
```
4. Set the default account:
```bash
meta-ads setup --non-interactive --token "<token>" --account-id "<account_id>"
```
5. Verify:
```bash
meta-ads auth status -o json
```

## Phase 2: Account Discovery

Read account from CLI config (always use the `act_` prefixed form — e.g., `act_903322579535495`):
```bash
jq -r '.defaults.account_id' ~/.config/meta-ads-cli/config.json
```

Fetch account name and currency:
```bash
meta-ads accounts get --account-id <account_id> -o json
```

Pull campaigns-meta for objective detection (reused by compute-defaults.sh):
```bash
meta-ads campaigns list --account-id <account_id> --limit 200 -o json > /tmp/_onboard_campaigns_meta.json
```

Get current per-objective performance defaults:
```bash
bash <skill-dir>/scripts/compute-defaults.sh <account_id> /tmp/_onboard_campaigns_meta.json
```
`<skill-dir>` is the directory containing this file's parent SKILL.md. Resolve from file path at runtime.

Output is `{"objectives": {"OUTCOME_SALES": {...}, "OUTCOME_TRAFFIC": {...}}, "total_spend": N, "objectives_detected": [...]}`.

Store results — used in Phase 4 (creative scan) and Phase 5 (target setting).

Present the objective breakdown to the user:
"Your account has [N] sales campaigns ([spend]), [N] traffic campaigns ([spend]), ..." for each detected objective.

Set `primary_objective` to the objective with highest spend.

Store `objectives_detected` — only objectives with >5% of total spend will get target prompts. Others get sensible defaults with a note.

## Phase 3: Brand Context

This is the most important phase.

CRITICAL: Steps 3a, 3b, 3c, and 3d are FOUR SEPARATE interactions. Each step gets its own AskUserQuestion call. Do NOT combine multiple steps into one AskUserQuestion. Do NOT skip any step even if you think you already know the answer from the website. Confirm each one individually.

### Step 3a: Website URL

Ask via AskUserQuestion: "What is your website or store URL?"
Options:
- The actual domain if known from context (e.g., "maisonx.in")
- "I don't have a website"
- Other (free text)

If URL provided — run a comprehensive site review. Do NOT just scrape the homepage; most e-commerce sites need deeper crawling (collection pages, product pages, about page, sitemap).

If subagents are available, spawn one for a thorough website review:
- Prompt: "Analyze <URL> comprehensively. Fetch the homepage, then discover the full catalog via sitemap.xml or by following navigation links. Visit at least 3-5 product/collection pages. Extract: all product categories, specific products with prices, brand positioning/voice, target audience signals, fabric/material details, unique selling points. Return a structured summary."
- The subagent handles 404s, JS SPAs, and sitemap discovery automatically.

Store the findings — use them to pre-fill suggestions in Steps 3b-3d. A comprehensive site review means confident product/price/audience suggestions rather than asking the user to type everything from scratch.

If subagents are unavailable, fall back to WebFetch: scrape homepage, then try /sitemap.xml to discover pages, then fetch 3-5 key pages (collections, products, about).

If all web access fails (auth wall, JS SPA, timeout): note gracefully ("Couldn't access the site — I'll ask you directly instead"), proceed to manual questions.

If user has no website: skip extraction, proceed to manual questions.

### Step 3b: Product/Service Description

If website was scraped successfully, pre-fill: "Based on your website, it looks like you sell [extracted description]. Is this accurate, or would you refine it?"

If no website data, ask directly: "Describe your product or service in one sentence. (e.g., 'Premium linen clothing for women')"

This must be a free-text answer, not a category picker.

### Step 3c: Price Range

This step is MANDATORY even if you extracted prices from the website. Website prices may not reflect the full range, bundles, or AOV.

If website data included price signals: "I found prices around [range] on your site. What is the typical price range and average order value? (e.g., Rs 1,499-2,999 per piece, AOV Rs 2,500)"

If no website data: "What is your typical price range? (e.g., Rs 2,000-8,000 per piece)"

### Step 3d: Target Audience

Ask: "Describe your target audience — age, location, interests. (e.g., Women 25-45, urban India, fashion-forward)"

If website data included audience signals (testimonials, imagery, language), suggest based on those.

## Phase 4: Creative Scan

Run the lightweight creative scan to identify proven patterns:
```bash
bash <skill-dir>/scripts/onboard-scan.sh <account_id>
```

Read the JSON output. Three scenarios:

**Scenario A: ads_with_conversions > 0** (most common)
- Read the `winners` array — identify common patterns in creative_body/creative_title:
  - What hooks do top ads use? (urgency, social proof, sensory, discount, etc.)
  - What format dominates winners? (video vs image from format_breakdown)
- Read the `losers` array — identify what losers have in common that winners lack
- Set:
  - Proven hook angles = patterns from winner copy
  - Winning format = dominant format in winners
  - Weak format = dominant format in losers

**Scenario B: ads_with_conversions == 0, total_ads > 0**
- Ads exist but no conversion data yet
- Set fallback: "No conversion data yet. Hook angles and format preferences will be populated after the first analysis with conversion data."

**Scenario C: total_ads == 0**
- Brand new account, no ads
- Set fallback: "No ads in account yet. Creative patterns will be populated after ads start running."

## Phase 5: Target Setting

For each detected objective above the 5% spend threshold, ask for the relevant targets. Batch objectives into as few AskUserQuestion calls as reasonable (group by topic, max 4 questions per call).

### Per-objective targets

**OUTCOME_SALES**: "Your sales CPA is [current_cpa]. What is your target CPA?" + "Your sales ROAS is [current_roas]. Target ROAS?"

**OUTCOME_TRAFFIC**: "Your traffic CPC is [current_cpc]. Target CPC?" + "Your CTR is [current_ctr]%. Target CTR?"

**OUTCOME_AWARENESS**: "Your CPM is [current_cpm]. Target CPM?" + "Target max frequency for awareness? (default 3.0)"

**OUTCOME_ENGAGEMENT**: "Your cost per engagement is [current_cpe]. Target CPE?"

**OUTCOME_LEADS**: "Your cost per lead is [current_cpl]. Target CPL?"

**OUTCOME_APP_PROMOTION**: "Your cost per install is [current_cpi]. Target CPI?"

### Global targets (ask once, not per-objective)

1. Max Frequency — "Default is 5.0 (above this = audience saturation). Keep default or adjust?"
2. Min Spend Threshold — "Minimum spend to include an ad set in recommendations. Filters noise." Suggest sensible default based on currency (1000 for INR, 10 for USD/EUR).

For objectives below 5% spend threshold: use sensible defaults and note "Your [objective] campaigns are <5% of spend — using default [metric] target. Update in config.json anytime."

If compute-defaults.sh returned null for a metric (zero conversions): note "No [conversion type] data yet — set approximate targets. You can update these later in ~/.meta-ads-intel/config.json."

## Phase 6: Write Configuration

Write `~/.meta-ads-intel/config.json`:
```json
{
  "account_id": "<account_id>",
  "account_name": "<name>",
  "currency": "<currency>",
  "config_version": 2,
  "objectives_detected": ["OUTCOME_SALES", "OUTCOME_TRAFFIC"],
  "primary_objective": "OUTCOME_SALES",
  "targets": {
    "global": {
      "max_frequency": 5.0,
      "min_spend": 1000
    },
    "OUTCOME_SALES": {
      "cpa": 1100,
      "roas": 4.0
    },
    "OUTCOME_TRAFFIC": {
      "cpc": 5,
      "ctr": 2.0
    }
  },
  "analysis": {
    "top_n": 15,
    "bottom_n": 10,
    "zero_conversion_n": 10
  }
}
```

Only include objectives detected in the account. Per-objective target keys:
- OUTCOME_SALES: `cpa`, `roas`
- OUTCOME_TRAFFIC: `cpc`, `ctr`
- OUTCOME_AWARENESS: `cpm`, `max_frequency`
- OUTCOME_ENGAGEMENT: `cpe`, `engagement_rate`
- OUTCOME_LEADS: `cpl`
- OUTCOME_APP_PROMOTION: `cpi`

Write brand context to `~/.meta-ads-intel/brand-context.md` (user-owned, survives skill updates). Use this format:

```markdown
## Brand Context

- Product: [real value from Phase 3b]
- Price point: [real value from Phase 3c]
- Audience: [real value from Phase 3d]
- Proven hook angles: [from Phase 4 creative scan, or "Pending first analysis" if no data]
- Winning format: [from Phase 4, or "Pending first analysis"]
- Weak format: [from Phase 4, or "Pending first analysis"]
```

Every field must have a real value. No TBD, no "to be filled later." If creative scan had no data (Scenario B or C), use the specific fallback text from Phase 4, not a generic placeholder.

Create data directories:
```bash
mkdir -p ~/.meta-ads-intel/data ~/.meta-ads-intel/reports ~/.meta-ads-intel/creatives
```

Print summary:
- Account: [name] ([id])
- Currency: [currency]
- Objectives: [list with spend %]
- Primary objective: [highest spend]
- Targets: [per-objective summary]
- Brand context: [product summary]
- Creative patterns: [hook angles or "pending first analysis"]

Final line: **"Setup complete. Run /meta-ads-intel again to start your first analysis."**

STOP HERE. Do not proceed to any analysis steps.
