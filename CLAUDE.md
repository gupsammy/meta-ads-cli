# meta-ads-cli

CLI for the Meta (Facebook) Marketing API v21.0. Manages ad accounts, campaigns, ad sets, ads, insights, and custom audiences.

## Development Commands

```bash
pnpm build        # compile with tsup → dist/
pnpm dev          # tsup --watch
pnpm test         # vitest run (71 tests across 12 files)
pnpm lint         # eslint src/
pnpm typecheck    # tsc --noEmit
```

Binary: `dist/index.js` (via package.json `bin` field). Requires Node >= 20.

## Project Structure

```
src/
  index.ts              # entry point, registers all commands
  auth.ts               # resolveAccessToken, saveToken, exchangeForLongLivedToken, OAuth flow
  commands/             # one file per subcommand group (+ setup, update, uninstall)
  lib/
    config.ts           # ConfigManager — reads/writes ~/.config/meta-ads-cli/config.json
    constants.ts        # API_VERSION, DESTRUCTIVE_STATUSES
    http.ts             # graphRequest, graphRequestWithRetry, paginateAll
    output.ts           # printOutput, printListOutput, printError, confirmAction, promptInput
```

Config stored at `~/.config/meta-ads-cli/config.json` (mode 0600). XDG_CONFIG_HOME respected.

## Authentication

Token resolution order: `--access-token` flag → `META_ADS_ACCESS_TOKEN` env → stored config.
OAuth flow uses `META_ADS_APP_ID` and `META_ADS_APP_SECRET` env vars (secret is never a CLI flag).
Required permissions: `ads_management`, `ads_read`.

## Command Inventory

### auth
| Command | Description | Required Args | Optional Args |
|---------|-------------|---------------|---------------|
| `auth login` | Authenticate | None | `--token`, `--app-id` (secret via env), `-o` |
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

### setup / update / uninstall
| Command | Description | Optional Args |
|---------|-------------|---------------|
| `setup` | Interactive guided setup (token, account selection) | `-o` |
| `update` | Update CLI to latest version | `--check`, `-o` |
| `uninstall` | Remove CLI and config | `--keep-config`, `--force`, `-o` |

## Non-Obvious Behaviors

- `--since`/`--until` must be used together — specifying only one exits with code 2.
- `insights --level` defaults to match the ID flag used (`--campaign-id` → campaign, etc.). Pass `--level` explicitly to override.
- `--status` filter on list commands filters by `effective_status`, not raw `status` — these differ when budget-limited.
- Default `--limit` for list commands is 50.
- Auto-retry covers HTTP 429 and 5xx — exponential backoff up to 3 retries; `retryAfter` header honored.
- Budgets are in the account's minor currency unit (cents for USD, paisa for INR) — divide by 100 for display.
- `campaigns create` default status is `PAUSED` — campaigns do not go live automatically.

## Output Format

- List commands: `{"data": [...], "has_more": false}` (with optional `"next_cursor"`)
- Single-item commands (get, create, update): plain objects `{"id": "...", ...}`
- Errors (stderr): `{"error": "CODE", "message": "...", "hint": "..."}`
- Always use `.data[]` not `.[]` when parsing list output with jq.
- `ads list`/`ads get` include flattened creative fields: `creative_id`, `creative_title`, `creative_body`, `creative_image_url`, `creative_thumbnail_url`.

## Destructive Operations

`campaigns update`, `adsets update`, `ads update` with `--status PAUSED/DELETED/ARCHIVED` prompt for confirmation interactively. In scripts (non-TTY), pass `--force` to avoid exit code 2. `auth logout` and `uninstall` also require `--force` non-interactively.

## Exit Codes

- `0` — success
- `1` — runtime error (API failure, network)
- `2` — usage error (bad flags, missing required args, cancelled confirmation)
