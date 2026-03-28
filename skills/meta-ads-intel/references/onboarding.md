# First-Run Onboarding

Triggered when Step 0 detects no `~/.meta-ads-intel/config.json`. Six phases: install, account discovery, brand context, creative scan, target setting, write config.

Onboarding is its own session. Do NOT continue to analysis after onboarding completes. The user runs /meta-ads-intel again for their first analysis.

During onboarding, present numbers in context ("Your CPA is Rs 1,104") but do not draw conclusions ("This is high/low/concerning") or make recommendations ("You should reduce spend on X"). Save all performance judgments for analysis mode.

When asking questions: use AskUserQuestion tool if available (minimum 2 options required). The tool automatically provides an "Other" free-text option to users — do not add one explicitly. Focus on providing a suggested value and a meaningful alternative (e.g., "I'd specify differently", "Help me decide"). Never use simple yes/no confirmation.

## Phase 1: Install & Setup

Check CLI and dependencies:
```bash
which meta-ads && meta-ads --version; which ffmpeg
```

If meta-ads not found — install globally (`meta-ads` must be on PATH, npx is not sufficient):
```bash
npm i -g meta-ads
```
If npm fails with permissions: suggest `sudo npm i -g meta-ads` or recommend nvm.

If ffmpeg missing: note "ffmpeg not installed — visual creative analysis will be skipped in future runs. Install with `brew install ffmpeg` when ready." NOT blocking.

### Authentication

Non-interactive shell environments cannot prompt for stdin — `meta-ads setup` without flags will fail. Use the non-interactive checkpoint flow. Each checkpoint is a verification gate — do not skip any.

1. Ask the user for their Meta API access token (via AskUserQuestion).
2. Save token without selecting account:
```bash
meta-ads setup --non-interactive --token "<token>" --skip-account
```
3. **Checkpoint: Auth verified.** Run `meta-ads auth status -o json`. Confirm output shows a valid token. If auth fails (expired token, missing scopes), stop and ask for a new token. Do not proceed without passing this checkpoint.
4. Discover accounts:
```bash
meta-ads accounts list -o json
```
5. Set the default account:
```bash
meta-ads setup --non-interactive --token "<token>" --account-id "<account_id>"
```
6. **Checkpoint: Account confirmed.** Run `meta-ads accounts get --account-id <account_id> -o json`. Confirm it returns account name and currency. Store both for Phase 6.

## Phase 2: Account Discovery

Account ID, name, and currency are already confirmed from Phase 1 checkpoints. Use the `act_` prefixed form (e.g., `act_903322579535495`).

Get current per-objective performance defaults:
```bash
meta-ads intel defaults --account-id <account_id> -o json
```

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

If URL provided — run a comprehensive site review. Do NOT just scrape the homepage; most e-commerce sites need deeper crawling (collection pages, product pages, about page, sitemap).

Spawn a **general-purpose** subagent (subagent_type: "general-purpose") for a thorough website review. Do NOT use an Explore agent — it lacks the web tools needed for comprehensive crawling.
- Prompt: "Analyze <URL> comprehensively. Use WebFetch to scrape the homepage, then discover the full catalog via sitemap.xml or by following navigation links (collection pages, category pages). Visit at least 5-8 product/collection pages plus the about page. Extract: all product categories with subcategories, specific products with prices and materials, brand positioning/voice/tone, target audience signals (imagery, language, testimonials), fabric/material details, unique selling points, price tiers. Return a detailed structured summary organized by category."
- The subagent has full access to WebFetch, WebSearch, and Bash — it handles 404s, JS SPAs, redirects, and sitemap discovery automatically.

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
meta-ads intel scan --account-id <account_id> -o json
```

Read the JSON output. Three scenarios:

**Scenario A: ads_with_conversions > 0** (most common)
- Analyze the top 5 winners by primary KPI. For each, note: format (video/image/static), whether creative_body is present, and the opening hook angle if copy exists. Summarize as a structured list, not prose.
- If >80% of winners have empty creative_body, note "video-first account — copy analysis limited to titles and ads with body text."
- What format dominates winners? (video vs image vs static from format_breakdown)
- If `format_breakdown.confidence` is `"low"`, caveat format insights: "Format detection is approximate — some ads could not be classified."
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

### Summary-first approach

Present all per-objective current metrics from `intel defaults` in a summary table:

"Here's your current performance across objectives:
| Objective | Spend % | Key Metrics |
| --- | --- | --- |
| Sales | 97% | CPA Rs 1,104 · ROAS 3.07x |
| Traffic | 2.6% | CPC Rs 0.85 · CTR 0.57% |
| Awareness | 0.2% | CPM Rs 6.03 · Freq 1.2 |"

Then ask one AskUserQuestion: "I'll use current performance as baseline targets for objectives above 5% of spend, and auto-set defaults for the rest. Which would you like to customize?"
Options: "Use current values as targets (Recommended)", "I want to set custom targets for specific objectives", "Help me understand these metrics"

If user selects custom targets, expand into per-metric questions only for the objectives they want to customize:

**OUTCOME_SALES**: "Your sales CPA is [current_cpa]. What is your target CPA?" + "Your sales ROAS is [current_roas]. Target ROAS?"

**OUTCOME_TRAFFIC**: "Your traffic CPC is [current_cpc]. Target CPC?" + "Your link-click CTR is [current_link_ctr]%. Target CTR?"

**OUTCOME_AWARENESS**: "Your CPM is [current_cpm]. Target CPM?" + "Target max frequency for awareness? (default 3.0)"

**OUTCOME_AWARENESS (VIDEO_VIEWS campaigns)**: If `intel defaults` returned `current_cpv`, also offer: "Your cost per video view is [current_cpv]. Set a CPV target? (Optional — CPM is the primary awareness metric.)"

**OUTCOME_ENGAGEMENT**: "Your cost per engagement is [current_cpe]. Target CPE?"

**OUTCOME_LEADS**: "Your cost per lead is [current_cpl]. Target CPL?"

**OUTCOME_APP_PROMOTION**: "Your cost per install is [current_cpi]. Target CPI?"

### Global targets (ask once, not per-objective)

1. Max Frequency — "Default is 5.0 (above this = audience saturation). Keep default or adjust?"
2. Min Spend Threshold — "Minimum spend to include an ad set in recommendations. Filters noise." Suggest sensible default based on currency (1000 for INR, 10 for USD/EUR).

### Funnel benchmarks

Present the funnel benchmarks that will be used for bottleneck detection:

"I'll use these funnel benchmarks for bottleneck detection during analysis:"

Present the funnel benchmarks from `references/thresholds.md` "Funnel Expected Rates" section in a summary table. These are the defaults for bottleneck detection. Add: "These are general e-commerce defaults. For luxury, B2B, or non-standard funnels, you may want to adjust."

AskUserQuestion: "Use these funnel benchmarks?"
Options: "Use defaults (Recommended)", "I want to customize"

If the user selects "I want to customize", show per-stage questions for the primary objective only. For non-primary objectives, use defaults. Write the resulting rates into config.json under `funnel_expected_rates` (see Phase 6 schema). Only include objectives detected in the account.

For objectives below 5% spend threshold: use sensible defaults and note "Your [objective] campaigns are <5% of spend — using default [metric] target. Update in config.json anytime."

If `intel defaults` returned null for a metric (zero conversions): note "No [conversion type] data yet — set approximate targets. You can update these later in ~/.meta-ads-intel/config.json."

### Default Disclosure

After collecting all user-set targets, explicitly list all auto-assigned defaults for sub-5% objectives before writing config:

"For objectives below 5% of spend, I'm using these defaults:
- [objective] ([spend%]): [metric] = [value], [metric] = [value]
...
You can update these anytime in ~/.meta-ads-intel/config.json."

This ensures the user knows exactly what baseline their campaigns will be judged against.

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
  },
  "funnel_expected_rates": {
    "OUTCOME_SALES": {
      "click_rate": 3.0, "landing_rate": 70.0,
      "add_to_cart_rate": 8.0, "cart_to_checkout": 50.0,
      "checkout_to_purchase": 60.0
    },
    "OUTCOME_TRAFFIC": {
      "click_rate": 1.5, "landing_rate": 70.0
    },
    "OUTCOME_AWARENESS": {},
    "OUTCOME_ENGAGEMENT": {
      "engagement_rate": 2.0, "deep_engagement_rate": 15.0
    },
    "OUTCOME_LEADS": {
      "click_rate": 2.0, "landing_rate": 60.0,
      "lead_conversion_rate": 5.0
    },
    "OUTCOME_APP_PROMOTION": {
      "click_rate": 1.5, "install_rate": 5.0
    }
  }
}
```

Only include objectives detected in the account. Per-objective target keys:
- OUTCOME_SALES: `cpa`, `roas`
- OUTCOME_TRAFFIC: `cpc`, `ctr`
- OUTCOME_AWARENESS: `cpm`, `max_frequency`
- OUTCOME_ENGAGEMENT: `cpe`
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

---

## Reconfigure Mode

Triggered by `/meta-ads-intel reconfigure` when config.json already exists. Allows selective updates without full re-onboarding.

Read existing `~/.meta-ads-intel/config.json` and `~/.meta-ads-intel/brand-context.md`.

Ask via AskUserQuestion: "What would you like to update?"
Options:
- "Update targets" — re-run `intel defaults` for fresh current metrics, then go through Phase 5 (summary-first target setting)
- "Update brand context" — re-run Phase 3 (website + brand questions) and Phase 4 (creative scan)
- "Full re-onboarding" — wipe config and start from Phase 1

For target updates: preserve account_id, currency, objectives_detected. Only rewrite the `targets` section of config.json.

For brand context updates: preserve config.json entirely. Only rewrite brand-context.md.

For full re-onboarding: delete config.json and follow the standard onboarding flow from Phase 1.

After any update, print a summary of what changed and confirm: "Config updated. Run /meta-ads-intel to start analysis."
