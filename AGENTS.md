# meta-ads-cli - Agent Guide

## Overview
CLI for the Meta (Facebook) Marketing API v21.0. Manages ad accounts, campaigns, ad sets, ads, insights, and custom audiences.

## Authentication Setup

```bash
# Option 1: Set token directly
meta-ads auth login --token <access_token>

# Option 2: Environment variable
export META_ADS_ACCESS_TOKEN=<access_token>

# Option 3: OAuth2 flow (requires Meta App credentials)
export META_ADS_APP_ID=<app_id>
export META_ADS_APP_SECRET=<app_secret>
meta-ads auth login --app-id $META_ADS_APP_ID --app-secret $META_ADS_APP_SECRET

# Verify auth
meta-ads auth status -o json
```

**Required permissions:** `ads_management`, `ads_read`

## Command Inventory

### auth
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `auth login` | Authenticate | None | `--token`, `--app-id`, `--app-secret`, `-o` |
| `auth status` | Show auth status | None | `-o` |
| `auth logout` | Remove credentials | None | `-o` |

### accounts
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `accounts list` | List ad accounts | None | `--access-token`, `--limit`, `-o`, `-q`, `-v` |
| `accounts get` | Get account details | `--account-id` | `--access-token`, `-o`, `-q`, `-v` |

### campaigns
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `campaigns list` | List campaigns | `--account-id` | `--status`, `--limit`, `--after`, `--access-token`, `-o`, `-q`, `-v` |
| `campaigns get` | Get campaign | `--campaign-id` | `--access-token`, `-o`, `-q`, `-v` |
| `campaigns create` | Create campaign | `--account-id`, `--name`, `--objective` | `--status`, `--daily-budget`, `--lifetime-budget`, `--special-ad-categories`, `--dry-run`, `--access-token`, `-o`, `-q`, `-v` |
| `campaigns update` | Update campaign | `--campaign-id` | `--name`, `--status`, `--daily-budget`, `--lifetime-budget`, `--dry-run`, `--access-token`, `-o`, `-q`, `-v` |

### adsets
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `adsets list` | List ad sets | `--account-id` | `--campaign-id`, `--status`, `--limit`, `--after`, `--access-token`, `-o`, `-q`, `-v` |
| `adsets get` | Get ad set | `--adset-id` | `--access-token`, `-o`, `-q`, `-v` |
| `adsets create` | Create ad set | `--account-id`, `--campaign-id`, `--name`, `--billing-event`, `--optimization-goal` | `--daily-budget`, `--lifetime-budget`, `--bid-amount`, `--targeting`, `--start-time`, `--end-time`, `--status`, `--dry-run`, `--access-token`, `-o`, `-q`, `-v` |
| `adsets update` | Update ad set | `--adset-id` | `--name`, `--status`, `--daily-budget`, `--lifetime-budget`, `--bid-amount`, `--targeting`, `--dry-run`, `--access-token`, `-o`, `-q`, `-v` |

### ads
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `ads list` | List ads | `--account-id` | `--adset-id`, `--campaign-id`, `--status`, `--limit`, `--after`, `--access-token`, `-o`, `-q`, `-v` |
| `ads get` | Get ad details | `--ad-id` | `--access-token`, `-o`, `-q`, `-v` |
| `ads update` | Update ad | `--ad-id` | `--name`, `--status`, `--dry-run`, `--access-token`, `-o`, `-q`, `-v` |

### insights
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `insights get` | Get insights | At least one of: `--account-id`, `--campaign-id`, `--adset-id`, `--ad-id` | `--date-preset`, `--since`, `--until`, `--level`, `--fields`, `--limit`, `--access-token`, `-o`, `-q`, `-v` |

### audiences
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `audiences list` | List audiences | `--account-id` | `--limit`, `--after`, `--access-token`, `-o`, `-q`, `-v` |
| `audiences get` | Get audience | `--audience-id` | `--access-token`, `-o`, `-q`, `-v` |

## Common Workflows

### List all active campaigns with insights
```bash
# Get account ID
ACCOUNT_ID=$(meta-ads accounts list -o json | jq -r '.[0].id')

# List active campaigns
meta-ads campaigns list --account-id $ACCOUNT_ID --status ACTIVE -o json

# Get insights for each campaign
meta-ads insights get --account-id $ACCOUNT_ID --date-preset last_30d --level campaign -o json
```

### Create a campaign with ad set
```bash
# Create campaign (paused)
CAMPAIGN_ID=$(meta-ads campaigns create --account-id act_123 --name "Q1 Traffic" --objective OUTCOME_TRAFFIC -o json | jq -r '.id')

# Create ad set targeting US adults
meta-ads adsets create \
  --account-id act_123 \
  --campaign-id $CAMPAIGN_ID \
  --name "US Adults" \
  --billing-event IMPRESSIONS \
  --optimization-goal LINK_CLICKS \
  --daily-budget 2000 \
  --targeting '{"geo_locations":{"countries":["US"]},"age_min":18,"age_max":65}'

# Activate campaign when ready
meta-ads campaigns update --campaign-id $CAMPAIGN_ID --status ACTIVE
```

### Pause all campaigns
```bash
meta-ads campaigns list --account-id act_123 --status ACTIVE -o json | \
  jq -r '.[].id' | \
  while read id; do meta-ads campaigns update --campaign-id "$id" --status PAUSED; done
```

## Output Format Notes

### JSON output structure
- List commands return arrays: `[{"id": "...", "name": "..."}, ...]`
- Single-item commands return objects: `{"id": "...", "name": "..."}`
- Error format: `{"error": {"code": "ERROR_CODE", "message": "..."}}`

### Date formats
- Timestamps from API: ISO 8601 with timezone (e.g., `2024-01-15T10:00:00+0000`)
- Insight dates: `YYYY-MM-DD` format
- Input dates for `--since`/`--until`: `YYYY-MM-DD` format

## Error Codes
| Code | Meaning | Action |
|------|---------|--------|
| `AUTH_FAILED` | Invalid or expired token | Run `meta-ads auth login` |
| `RATE_LIMITED` | Too many API calls | Wait and retry (auto-retry built in) |
| `API_ERROR_100` | Invalid parameter | Check parameter values |
| `API_ERROR_190` | Invalid access token | Generate new token |
| `API_ERROR_200` | Permissions error | Check app permissions |
| `API_ERROR_2635` | Ad account disabled | Check account status in Business Manager |

## Rate Limits
- Standard: ~200 calls per hour per ad account
- Auto-retry with exponential backoff on HTTP 429
- Use `--verbose` to see rate limit info
- Use `--limit` on list commands to reduce API calls
