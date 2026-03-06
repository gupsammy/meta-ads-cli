# meta-ads-cli

[![CI](https://github.com/gupsammy/meta-ads-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/gupsammy/meta-ads-cli/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Command-line interface for the Meta (Facebook) Marketing API. Manage campaigns, ad sets, ads, insights, and audiences from your terminal.

## Install

This is a source-only fork. Build and link it locally:

```bash
git clone https://github.com/gupsammy/meta-ads-cli.git
cd meta-ads-cli
pnpm install
pnpm build
npm link   # makes `meta-ads` available globally
```

## Quick Start

```bash
# Authenticate with a token
meta-ads auth login --token YOUR_ACCESS_TOKEN

# Or use OAuth2 flow (requires Meta App credentials via env vars)
export META_ADS_APP_ID=YOUR_APP_ID
export META_ADS_APP_SECRET=YOUR_APP_SECRET
meta-ads auth login --app-id $META_ADS_APP_ID

# List ad accounts (default output: table)
meta-ads accounts list

# List campaigns for an account
meta-ads campaigns list --account-id act_123456

# Get campaign insights for the last 30 days
meta-ads insights get --account-id act_123456 --date-preset last_30d

# Create a new campaign (paused by default)
meta-ads campaigns create --account-id act_123456 --name "My Campaign" --objective OUTCOME_TRAFFIC
```

## Authentication

meta-ads-cli supports three authentication methods (in priority order):

### 1. Per-command flag
```bash
meta-ads accounts list --access-token YOUR_TOKEN
```

### 2. Environment variable
```bash
export META_ADS_ACCESS_TOKEN=YOUR_TOKEN
meta-ads accounts list
```

### 3. Config file (saved via `auth login`)
```bash
# Save a token to the config file
meta-ads auth login --token YOUR_TOKEN

# OAuth2 flow — app secret must be in the environment, not a CLI flag
export META_ADS_APP_SECRET=YOUR_APP_SECRET
meta-ads auth login --app-id YOUR_APP_ID

# Check auth status
meta-ads auth status
```

The config file is stored at `~/.config/meta-ads-cli/config.json` (or `$XDG_CONFIG_HOME/meta-ads-cli/config.json` if set).

> **Security note:** Passing tokens as CLI flags leaks them into shell history and process listings. Prefer environment variables or stdin: `echo $TOKEN | meta-ads auth login --token -`

### Getting an access token

1. Go to [Meta for Developers](https://developers.facebook.com/) and create an app
2. In the App Dashboard, go to Tools > Graph API Explorer
3. Select your app and generate a User Token with `ads_management` and `ads_read` permissions
4. Use `meta-ads auth login --token <your-token>` to save it

For long-lived tokens, use the full OAuth2 flow with `--app-id` and `META_ADS_APP_SECRET`.

## Command Reference

### auth
```bash
meta-ads auth login [--token <token>] [--app-id <id>]   # app secret via META_ADS_APP_SECRET
meta-ads auth status
meta-ads auth logout [--force]
```

### accounts
```bash
meta-ads accounts list [--limit <n>] [--after <cursor>]
meta-ads accounts get --account-id <id>
```

### campaigns
```bash
meta-ads campaigns list --account-id <id> [--status <status>] [--limit <n>] [--after <cursor>]
meta-ads campaigns get --campaign-id <id>
meta-ads campaigns create --account-id <id> --name <name> --objective <objective> [--status <status>] [--daily-budget <cents>] [--lifetime-budget <cents>] [--special-ad-categories <cats>] [--dry-run]
meta-ads campaigns update --campaign-id <id> [--name <name>] [--status <status>] [--daily-budget <cents>] [--dry-run] [--force]
```

**Objectives:** `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_APP_PROMOTION`, `OUTCOME_SALES`

**Statuses:** `ACTIVE`, `PAUSED`, `DELETED`, `ARCHIVED`

**Special ad categories:** `CREDIT`, `EMPLOYMENT`, `HOUSING`, `ISSUES_ELECTIONS_POLITICS` (comma-separated)

> Updating to `PAUSED`, `DELETED`, or `ARCHIVED` prompts for confirmation. Use `--force` to skip in non-interactive (CI/pipeline) contexts.

### adsets
```bash
meta-ads adsets list --account-id <id> [--campaign-id <id>] [--status <status>] [--limit <n>] [--after <cursor>]
meta-ads adsets get --adset-id <id>
meta-ads adsets create --account-id <id> --campaign-id <id> --name <name> --billing-event <event> --optimization-goal <goal> [--daily-budget <cents>] [--lifetime-budget <cents>] [--bid-amount <cents>] [--targeting <json>] [--start-time <iso8601>] [--end-time <iso8601>] [--dry-run]
meta-ads adsets update --adset-id <id> [--name <name>] [--status <status>] [--daily-budget <cents>] [--lifetime-budget <cents>] [--bid-amount <cents>] [--targeting <json>] [--dry-run] [--force]
```

### ads
```bash
meta-ads ads list --account-id <id> [--adset-id <id>] [--campaign-id <id>] [--status <status>] [--limit <n>] [--after <cursor>]
meta-ads ads get --ad-id <id>
meta-ads ads update --ad-id <id> [--name <name>] [--status <status>] [--dry-run] [--force]
```

Ad list/get responses include flattened creative fields: `creative_id`, `creative_title`, `creative_body`, `creative_image_url`, `creative_thumbnail_url`.

### insights
```bash
meta-ads insights get --account-id <id> [--date-preset <preset>] [--since <date> --until <date>] [--level <level>] [--fields <fields>] [--time-increment <days>] [--limit <n>]
meta-ads insights get --campaign-id <id> [--date-preset last_30d]
meta-ads insights get --adset-id <id> [--since 2024-01-01 --until 2024-01-31]
meta-ads insights get --ad-id <id> [--date-preset yesterday]
```

At least one of `--account-id`, `--campaign-id`, `--adset-id`, `--ad-id` is required.

**Date presets:** `today`, `yesterday`, `this_month`, `last_month`, `last_7d`, `last_14d`, `last_28d`, `last_30d`, `last_90d`, `this_quarter`, `last_quarter`, `last_year`

**Levels:** `account`, `campaign`, `adset`, `ad`

**`--time-increment <n>`:** Set to `1` for daily breakdown. Adds a `date_start`/`date_stop` row per day.

### audiences
```bash
meta-ads audiences list --account-id <id> [--limit <n>] [--after <cursor>]
meta-ads audiences get --audience-id <id>
```

## Output Formats

All data commands support `--output` / `-o` with three formats:

```bash
# Table (default) - human-readable
meta-ads campaigns list --account-id act_123

# JSON - machine-readable; list commands include pagination metadata
meta-ads campaigns list --account-id act_123 -o json
# → {"data": [...], "has_more": false}

# CSV - for spreadsheets and pipelines
meta-ads campaigns list --account-id act_123 -o csv
```

Additional flags:
- `--verbose` / `-v` - Log HTTP requests and responses to stderr
- `--access-token <token>` - Override the stored/env token for a single invocation

Color is automatically disabled when `NO_COLOR` is set, `TERM=dumb`, or stdout is not a TTY.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (API failure, network error) |
| `2` | Usage error (missing required flags, cancelled confirmation, invalid input) |

## Configuration

Config file location: `~/.config/meta-ads-cli/config.json` (or `$XDG_CONFIG_HOME/meta-ads-cli/config.json`)

Written by `auth login`, permissions set to `0600` (owner-only).

```json
{
  "auth": {
    "access_token": "...",
    "app_id": "..."
  }
}
```

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

MIT
