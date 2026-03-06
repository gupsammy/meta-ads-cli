# meta-ads-cli

CLI for the Meta (Facebook) Marketing API v21.0. Manages ad accounts, campaigns, ad sets, ads, insights, and custom audiences.

## Development Commands

```bash
pnpm build        # compile with tsup → dist/
pnpm dev          # tsup --watch
pnpm test         # vitest run (46 tests across 8 files)
pnpm lint         # eslint src/
pnpm typecheck    # tsc --noEmit
```

Binary: `./bin/meta-ads` (links to `dist/index.js`). Requires Node >= 20.

## Project Structure

```
src/
  index.ts              # entry point, registers all commands
  auth.ts               # requireAccessToken() helper
  commands/             # one file per subcommand group
  lib/
    config.ts           # ConfigManager — reads/writes ~/.config/meta-ads-cli/config.json
    http.ts             # graphRequest, graphRequestWithRetry, paginateAll
    output.ts           # printOutput, printListOutput, printError, confirmAction
```

Config stored at `~/.config/meta-ads-cli/config.json` (mode 0600). XDG_CONFIG_HOME respected.

## Authentication Setup

```bash
# Option 1: Set token directly
meta-ads auth login --token <access_token>

# Option 2: Environment variable (no login needed)
export META_ADS_ACCESS_TOKEN=<access_token>

# Option 3: OAuth2 flow — app secret MUST be env var, not a CLI flag
export META_ADS_APP_ID=<app_id>
export META_ADS_APP_SECRET=<app_secret>
meta-ads auth login --app-id $META_ADS_APP_ID

# Verify auth
meta-ads auth status -o json
```

**Required permissions:** `ads_management`, `ads_read`

## Command Inventory

### auth
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `auth login` | Authenticate | None | `--token`, `--app-id` (secret via `META_ADS_APP_SECRET` env), `-o` |
| `auth status` | Show auth status | None | `-o` |
| `auth logout` | Remove credentials | None | `--force`, `-o` |

### accounts
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `accounts list` | List ad accounts | None | `--access-token`, `--limit`, `--after`, `-o`, `-v` |
| `accounts get` | Get account details | `--account-id` | `--access-token`, `-o`, `-v` |

### campaigns
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `campaigns list` | List campaigns | `--account-id` | `--status`, `--limit`, `--after`, `--access-token`, `-o`, `-v` |
| `campaigns get` | Get campaign | `--campaign-id` | `--access-token`, `-o`, `-v` |
| `campaigns create` | Create campaign | `--account-id`, `--name`, `--objective` | `--status`, `--daily-budget`, `--lifetime-budget`, `--special-ad-categories`, `--dry-run`, `--access-token`, `-o`, `-v` |
| `campaigns update` | Update campaign | `--campaign-id` | `--name`, `--status`, `--daily-budget`, `--lifetime-budget`, `--force`, `--dry-run`, `--access-token`, `-o`, `-v` |

### adsets
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `adsets list` | List ad sets | `--account-id` | `--campaign-id`, `--status`, `--limit`, `--after`, `--access-token`, `-o`, `-v` |
| `adsets get` | Get ad set | `--adset-id` | `--access-token`, `-o`, `-v` |
| `adsets create` | Create ad set | `--account-id`, `--campaign-id`, `--name`, `--billing-event`, `--optimization-goal` | `--daily-budget`, `--lifetime-budget`, `--bid-amount`, `--targeting`, `--start-time`, `--end-time`, `--status`, `--dry-run`, `--access-token`, `-o`, `-v` |
| `adsets update` | Update ad set | `--adset-id` | `--name`, `--status`, `--daily-budget`, `--lifetime-budget`, `--bid-amount`, `--targeting`, `--force`, `--dry-run`, `--access-token`, `-o`, `-v` |

### ads
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `ads list` | List ads | `--account-id` | `--adset-id`, `--campaign-id`, `--status`, `--limit`, `--after`, `--access-token`, `-o`, `-v` |
| `ads get` | Get ad details | `--ad-id` | `--access-token`, `-o`, `-v` |
| `ads update` | Update ad | `--ad-id` | `--name`, `--status`, `--force`, `--dry-run`, `--access-token`, `-o`, `-v` |

### insights
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `insights get` | Get insights | At least one of: `--account-id`, `--campaign-id`, `--adset-id`, `--ad-id` | `--date-preset`, `--since`, `--until`, `--level`, `--fields`, `--time-increment`, `--limit`, `--access-token`, `-o`, `-v` |

### audiences
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `audiences list` | List audiences | `--account-id` | `--limit`, `--after`, `--access-token`, `-o`, `-v` |
| `audiences get` | Get audience | `--audience-id` | `--access-token`, `-o`, `-v` |

## Non-Obvious Behaviors

- **`--since`/`--until` must be used together** — specifying only one exits with error code 2.
- **`insights --level` defaults to match the ID flag used** — `--campaign-id` → `campaign`, `--adset-id` → `adset`, `--ad-id` → `ad`, `--account-id` → `account`. Pass `--level` explicitly to override (e.g., campaign-id + `--level ad` for per-ad rows within a campaign).
- **`--status` filter on list commands** filters by `effective_status`, not the raw `status` field — these differ when campaigns are budget-limited.
- **Default `--limit` for list commands is 50** — pass a higher value for bulk pulls.
- **Auto-retry covers HTTP 429 and 5xx** — exponential backoff up to 3 retries; `retryAfter` header honored on 429.
- **Budgets are in the account's minor currency unit** (e.g., cents for USD, paisa for INR) — divide by 100 for display.
- **`campaigns create` default status is `PAUSED`** — campaigns do not go live automatically.

## Common Workflows

### List all active campaigns with insights
```bash
# Get account ID — list JSON returns {"data": [...], "has_more": false}
ACCOUNT_ID=$(meta-ads accounts list -o json | jq -r '.data[0].id')

# List active campaigns
meta-ads campaigns list --account-id $ACCOUNT_ID --status ACTIVE -o json

# Get campaign-level insights (must specify --level; default is account)
meta-ads insights get --account-id $ACCOUNT_ID --date-preset last_30d --level campaign -o json
```

### Create a campaign with ad set
```bash
# Create campaign (paused) — single-item commands return a plain object
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

# Activate campaign when ready (non-interactive: use --force to skip confirmation)
meta-ads campaigns update --campaign-id $CAMPAIGN_ID --status ACTIVE --force
```

### Pause all campaigns
```bash
# List JSON: access items via .data[]
meta-ads campaigns list --account-id act_123 --status ACTIVE -o json | \
  jq -r '.data[].id' | \
  while read id; do meta-ads campaigns update --campaign-id "$id" --status PAUSED --force; done
```

## Output Format Notes

### JSON output structure
- List commands return a pagination wrapper: `{"data": [{"id": "...", "name": "..."}, ...], "has_more": false}`
- When more pages exist: `{"data": [...], "has_more": true, "next_cursor": "..."}`
- Single-item commands (get, create, update) return plain objects: `{"id": "...", "name": "..."}`
- Error format (to stderr): `{"error": "ERROR_CODE", "message": "...", "hint": "..."}` (hint may be null)

**Always use `.data[]` not `.[]` when parsing list output with jq.**

### Ads creative fields
`ads list` and `ads get` include flattened creative metadata: `creative_id`, `creative_title`, `creative_body`, `creative_image_url`, `creative_thumbnail_url`. Video-only ads may return empty strings for text fields.

### Destructive operations
`campaigns update`, `adsets update`, `ads update` with `--status PAUSED/DELETED/ARCHIVED` prompt for confirmation when run interactively. In scripts (non-TTY), always pass `--force` to avoid exit code 2. `auth logout` also requires `--force` in non-interactive mode.

### Exit codes
- `0` — success
- `1` — runtime error (API failure, network)
- `2` — usage error (bad flags, missing required args, cancelled confirmation without `--force`)

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
- Auto-retry with exponential backoff on HTTP 429 and 5xx errors (up to 3 retries)
- Use `--verbose` to see rate limit info
- Use `--limit` on list commands to reduce API calls
