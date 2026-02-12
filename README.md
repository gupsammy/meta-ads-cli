# meta-ads-cli

[![npm version](https://img.shields.io/npm/v/@marketing-clis/meta-ads-cli)](https://www.npmjs.com/package/@marketing-clis/meta-ads-cli)
[![CI](https://github.com/marketing-clis/meta-ads-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/marketing-clis/meta-ads-cli/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Command-line interface for the Meta (Facebook) Marketing API. Manage campaigns, ad sets, ads, insights, and audiences from your terminal.

## Install

```bash
npm install -g @marketing-clis/meta-ads-cli
```

## Quick Start

```bash
# Authenticate (set token directly)
meta-ads auth login --token YOUR_ACCESS_TOKEN

# Or use OAuth2 flow (requires Meta App)
meta-ads auth login --app-id YOUR_APP_ID --app-secret YOUR_APP_SECRET

# List ad accounts
meta-ads accounts list

# List campaigns for an account
meta-ads campaigns list --account-id act_123456

# Get campaign insights for the last 30 days
meta-ads insights get --account-id act_123456 --date-preset last_30d --output table

# Create a new campaign (paused by default)
meta-ads campaigns create --account-id act_123456 --name "My Campaign" --objective OUTCOME_TRAFFIC
```

## Authentication

meta-ads-cli supports three authentication methods (in priority order):

### 1. CLI Flag
```bash
meta-ads accounts list --access-token YOUR_TOKEN
```

### 2. Environment Variable
```bash
export META_ADS_ACCESS_TOKEN=YOUR_TOKEN
meta-ads accounts list
```

### 3. Config File
```bash
# Interactive OAuth2 login (saves token to config)
meta-ads auth login --app-id YOUR_APP_ID --app-secret YOUR_APP_SECRET

# Or directly set a token
meta-ads auth login --token YOUR_TOKEN

# Check auth status
meta-ads auth status
```

The config file is stored at `~/.config/meta-ads-cli/config.json`.

### Getting an Access Token

1. Go to [Meta for Developers](https://developers.facebook.com/) and create an app
2. In the App Dashboard, go to Tools > Graph API Explorer
3. Select your app and generate a User Token with `ads_management` and `ads_read` permissions
4. Use `meta-ads auth login --token <your-token>` to save it

For long-lived tokens, use the full OAuth2 flow with `--app-id` and `--app-secret`.

## Command Reference

### auth
```bash
meta-ads auth login [--token <token>] [--app-id <id> --app-secret <secret>]
meta-ads auth status
meta-ads auth logout
```

### accounts
```bash
meta-ads accounts list [--limit <n>]
meta-ads accounts get --account-id <id>
```

### campaigns
```bash
meta-ads campaigns list --account-id <id> [--status <status>] [--limit <n>]
meta-ads campaigns get --campaign-id <id>
meta-ads campaigns create --account-id <id> --name <name> --objective <objective> [--status <status>] [--daily-budget <cents>] [--dry-run]
meta-ads campaigns update --campaign-id <id> [--name <name>] [--status <status>] [--daily-budget <cents>] [--dry-run]
```

**Objectives:** `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_APP_PROMOTION`, `OUTCOME_SALES`

**Statuses:** `ACTIVE`, `PAUSED`, `DELETED`, `ARCHIVED`

### adsets
```bash
meta-ads adsets list --account-id <id> [--campaign-id <id>] [--status <status>] [--limit <n>]
meta-ads adsets get --adset-id <id>
meta-ads adsets create --account-id <id> --campaign-id <id> --name <name> --billing-event <event> --optimization-goal <goal> [--daily-budget <cents>] [--targeting <json>] [--dry-run]
meta-ads adsets update --adset-id <id> [--name <name>] [--status <status>] [--daily-budget <cents>] [--dry-run]
```

### ads
```bash
meta-ads ads list --account-id <id> [--adset-id <id>] [--campaign-id <id>] [--status <status>] [--limit <n>]
meta-ads ads get --ad-id <id>
meta-ads ads update --ad-id <id> [--name <name>] [--status <status>] [--dry-run]
```

### insights
```bash
meta-ads insights get --account-id <id> [--date-preset <preset>] [--since <date> --until <date>] [--level <level>] [--fields <fields>]
meta-ads insights get --campaign-id <id> [--date-preset last_30d]
meta-ads insights get --adset-id <id> [--since 2024-01-01 --until 2024-01-31]
meta-ads insights get --ad-id <id> [--date-preset yesterday]
```

**Date presets:** `today`, `yesterday`, `this_month`, `last_month`, `last_7d`, `last_14d`, `last_28d`, `last_30d`, `last_90d`

**Levels:** `account`, `campaign`, `adset`, `ad`

### audiences
```bash
meta-ads audiences list --account-id <id> [--limit <n>]
meta-ads audiences get --audience-id <id>
```

## Output Formats

All data commands support `--output` / `-o` with three formats:

```bash
# JSON (default) - machine-readable
meta-ads campaigns list --account-id act_123 -o json

# Table - human-readable
meta-ads campaigns list --account-id act_123 -o table

# CSV - for spreadsheets and pipelines
meta-ads campaigns list --account-id act_123 -o csv
```

Additional flags:
- `--quiet` / `-q` - Suppress non-essential output
- `--verbose` / `-v` - Debug logging including HTTP requests

## Configuration

Config file location: `~/.config/meta-ads-cli/config.json`

```json
{
  "auth": {
    "access_token": "...",
    "app_id": "...",
    "app_secret": "..."
  },
  "defaults": {
    "output": "table",
    "account_id": "act_123456"
  }
}
```

## Development

```bash
git clone https://github.com/marketing-clis/meta-ads-cli.git
cd meta-ads-cli
pnpm install
pnpm run build
pnpm run test
pnpm run typecheck
pnpm run lint
```

## Part of Marketing CLIs

This tool is part of [Marketing CLIs](https://github.com/marketing-clis/marketing-clis) -- open source CLIs for marketing tools that have APIs but lack command-line interfaces.

## License

MIT
