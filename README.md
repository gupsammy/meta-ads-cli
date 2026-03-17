<div align="center">

<h1>meta-ads</h1>

<p>Command-line interface for the Meta (Facebook) Marketing API.<br/>Manage campaigns, ad sets, ads, insights, and audiences from your terminal.</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/meta-ads.svg)](https://www.npmjs.com/package/meta-ads)

</div>

## Features

- Manage campaigns, ad sets, ads, and custom audiences from one CLI
- Pull performance insights with flexible date ranges, breakdowns, and levels
- Three output formats: table (human), JSON (machine), CSV (spreadsheets)
- Built-in retry with exponential backoff for rate limits and transient errors
- Interactive onboarding wizard (`meta-ads setup`) — zero to working CLI in one session
- Default account ID — configure once, skip `--account-id` on every command
- Self-update (`meta-ads update`) and clean uninstall (`meta-ads uninstall`)

## AI-Powered Analytics (meta-ads-intel)

This repo includes an AI agent skill that turns your ad account data into actionable intelligence. Works with any agent that supports the [skills.sh](https://skills.sh) ecosystem (Claude Code, Cursor, Codex, and more).

What it does:
- Budget optimization — classifies ad sets as scale/maintain/reduce/pause
- Creative analysis — ranks ads by ROAS, identifies winning messaging patterns and visual hooks
- Trend detection — period-over-period and week-over-week performance deltas
- Funnel diagnostics — pinpoints where conversions drop off (TOFU/MOFU/BOFU)
- Decision brief — top 3 actions, risks, and watch items

Install the skill and ask your agent to "analyze my ads." On first run, it auto-installs the CLI, authenticates, fetches your account info, and personalizes thresholds and brand context.

```bash
npx skills add gupsammy/meta-ads-cli
```

## Installation

### AI Agent Skill (Recommended)

If you use an AI coding agent (Claude Code, Cursor, Codex, etc.), install the meta-ads-intel skill. On first run, it installs the CLI, walks you through authentication, account setup, and brand configuration:

```bash
npx skills add gupsammy/meta-ads-cli
```

Once installed, just ask your agent to "analyze my ads" — the skill handles everything.

### One-line install (CLI only)

**macOS / Linux / WSL:**

```bash
curl -fsSL https://raw.githubusercontent.com/gupsammy/meta-ads-cli/master/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/gupsammy/meta-ads-cli/master/install.ps1 | iex
```

Handles everything: installs Node.js if needed, installs the CLI globally, and walks you through authentication and account setup.

### npm (If you already have Node.js >= 20)

```bash
npm install -g meta-ads
meta-ads setup
```

### npx (Try without installing, requires Node.js >= 20)

```bash
npx meta-ads accounts list --access-token YOUR_TOKEN
npx meta-ads insights get --account-id act_123 --date-preset last_7d --access-token YOUR_TOKEN
```

Note: with npx you must prefix every command with `npx`.

## Quick Start

```bash
# Run the interactive setup wizard
meta-ads setup

# Or configure non-interactively
meta-ads auth login --token YOUR_TOKEN
meta-ads setup --skip-auth --account-id act_123456

# List your ad accounts
meta-ads accounts list

# List campaigns (uses your default account)
meta-ads campaigns list

# Get insights for the last 30 days
meta-ads insights get --date-preset last_30d

# Create a campaign (paused by default)
meta-ads campaigns create --name "Q2 Traffic" --objective OUTCOME_TRAFFIC
```

## Authentication

meta-ads supports three authentication methods, checked in this order:

### 1. Per-command flag

```bash
meta-ads accounts list --access-token YOUR_TOKEN
```

### 2. Environment variable

```bash
export META_ADS_ACCESS_TOKEN=YOUR_TOKEN
meta-ads accounts list
```

### 3. Config file (saved via `auth login` or `setup`)

```bash
meta-ads auth login --token YOUR_TOKEN
meta-ads auth status
```

Config is stored at `~/.config/meta-ads-cli/config.json` with `0600` permissions (owner-only).

### Getting an access token

1. Go to [Meta for Developers](https://developers.facebook.com/) and create an app
2. Open Tools > Graph API Explorer
3. Generate a User Token with `ads_management` and `ads_read` permissions
4. Run `meta-ads setup` and paste the token when prompted

For long-lived tokens, set `META_ADS_APP_SECRET` in your environment and the setup wizard will offer to exchange your short-lived token automatically.

## Command Reference

### auth

```bash
meta-ads auth login [--token <token>] [--app-id <id>]   # app secret via META_ADS_APP_SECRET
meta-ads auth status [-o json]
meta-ads auth logout [--force]
```

### setup

```bash
meta-ads setup                                            # interactive wizard
meta-ads setup --non-interactive --token <t>              # scripted setup
meta-ads setup --skip-auth --account-id <id>              # set default account only
```

### accounts

```bash
meta-ads accounts list [--limit <n>] [--after <cursor>]
meta-ads accounts get --account-id <id>
```

### campaigns

```bash
meta-ads campaigns list [--account-id <id>] [--status <status>] [--limit <n>]
meta-ads campaigns get --campaign-id <id>
meta-ads campaigns create [--account-id <id>] --name <name> --objective <obj> [--daily-budget <cents>] [--dry-run]
meta-ads campaigns update --campaign-id <id> [--name <name>] [--status <status>] [--force]
```

Objectives: `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_APP_PROMOTION`, `OUTCOME_SALES`

### adsets

```bash
meta-ads adsets list [--account-id <id>] [--campaign-id <id>] [--status <status>]
meta-ads adsets get --adset-id <id>
meta-ads adsets create [--account-id <id>] --campaign-id <id> --name <name> --billing-event <event> --optimization-goal <goal> [--targeting <json>] [--dry-run]
meta-ads adsets update --adset-id <id> [--name <name>] [--status <status>] [--force]
```

### ads

```bash
meta-ads ads list [--account-id <id>] [--adset-id <id>] [--status <status>]
meta-ads ads get --ad-id <id>
meta-ads ads update --ad-id <id> [--name <name>] [--status <status>] [--force]
```

### insights

```bash
meta-ads insights get --account-id <id> [--date-preset last_30d] [--level campaign]
meta-ads insights get --campaign-id <id> [--since 2024-01-01 --until 2024-01-31]
meta-ads insights get --ad-id <id> [--time-increment 1]
```

At least one of `--account-id`, `--campaign-id`, `--adset-id`, `--ad-id` is required. When a default account is configured, `--account-id` can be omitted.

Date presets: `today`, `yesterday`, `last_7d`, `last_14d`, `last_28d`, `last_30d`, `last_90d`, `this_month`, `last_month`, `this_quarter`, `last_quarter`, `last_year`

### audiences

```bash
meta-ads audiences list [--account-id <id>] [--limit <n>]
meta-ads audiences get --audience-id <id>
```

### update

```bash
meta-ads update            # update to latest version
meta-ads update --check    # check without installing
```

### uninstall

```bash
meta-ads uninstall                  # prompts for confirmation
meta-ads uninstall --force          # skip confirmation
meta-ads uninstall --keep-config    # keep ~/.config/meta-ads-cli/
```

## Output Formats

All data commands support `--output` / `-o`:

```bash
meta-ads campaigns list -o table   # default, human-readable
meta-ads campaigns list -o json    # machine-readable with pagination
meta-ads campaigns list -o csv     # for spreadsheets and pipelines
```

JSON list responses: `{"data": [...], "has_more": false}`
JSON single-item responses: `{"id": "...", "name": "..."}`

Additional flags: `--verbose` / `-v` for HTTP logging, `--access-token` for per-command override.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (API failure, network) |
| `2` | Usage error (missing flags, cancelled confirmation) |

## Configuration

Config location: `~/.config/meta-ads-cli/config.json` (respects `$XDG_CONFIG_HOME`)

```json
{
  "auth": {
    "access_token": "...",
    "app_id": "..."
  },
  "defaults": {
    "account_id": "act_123456"
  }
}
```

Set your default account via `meta-ads setup` or `meta-ads setup --skip-auth --account-id <id>`.

## Development

```bash
git clone https://github.com/gupsammy/meta-ads-cli.git
cd meta-ads-cli
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## License

[MIT](LICENSE)
