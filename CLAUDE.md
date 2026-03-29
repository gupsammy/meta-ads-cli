# meta-ads-cli

CLI for the Meta (Facebook) Marketing API v21.0. Manages ad accounts, campaigns, ad sets, ads, insights, custom audiences, and runs the Intel analysis pipeline.

## Development Commands

```bash
pnpm build        # compile with tsup → dist/
pnpm dev          # tsup --watch
pnpm test         # vitest run (249 tests across 18 files)
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
  intel/                # analysis pipeline
    pull.ts             # full pipeline orchestrator: fetch → summarize → prepare
    summarize.ts        # compresses raw API JSON into *-summary.json files
    prepare/            # generates analysis outputs (account-health, budget-actions, funnel, trends, creative-analysis)
    scan.ts             # creative scan for onboarding
    defaults.ts         # compute target defaults from current performance
    metrics.ts          # extractMetrics + deriveMetrics — 27-field extraction from Meta API rows
    types.ts            # all Intel type definitions (API shapes, summaries, analysis outputs)
    objective-map.ts    # maps Meta objective strings to KPI sets
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

### Core commands

`auth login|status|logout`, `accounts list|get`, `campaigns list|get|create|update`, `adsets list|get|create|update`, `ads list|get|update`, `insights get`, `audiences list|get`, `setup`, `update`, `uninstall`.

All list commands accept `--limit`, `--after`, `--access-token`, `-o`, `-v`. Create/update commands accept `--dry-run`. See `meta-ads <command> --help` for full flag details.

### intel (hidden)

| Command | Description | Args |
|---------|-------------|------|
| `intel run [date-preset]` | Full pipeline: fetch → summarize → prepare | Default `last_14d`. Options: `last_7d`, `last_14d`, `last_30d` |
| `intel defaults` | Compute target KPI defaults | `--account-id`, `--access-token` |
| `intel scan` | Creative scan for onboarding | `--account-id`, `--access-token` |
| `intel recommendations list` | Fetch Meta AI recommendations for account | `--account-id`, `--access-token` |

## Intel Pipeline

`intel run` orchestrates a full data pull + analysis. It fetches campaigns, ad sets, ads (with creatives), and insights from the Meta API in parallel, then runs `summarize` (compress raw JSON to summaries) and `prepare` (generate analysis files).

Data directory: `META_ADS_DATA_DIR` env → `~/.meta-ads-intel/data/`. Each run creates a timestamped subdirectory (`YYYY-MM-DD_HHMM/`). A `_recent_raw/` symlink always points to the latest raw data.

Account ID resolution: `META_ADS_ACCOUNT_ID` env → `~/.meta-ads-intel/config.json` → CLI config's `default_account_id`.

Key behaviors:
- Sets `umask 077` during execution (ad spend data is sensitive) — restored in `finally`.
- Directory-based lock at `{dataDir}/.pull-lock/` prevents concurrent runs. Stale locks auto-removed after 30 minutes.
- `campaigns-summary.json` is required after summarize — missing it is a hard error.
- Symlinks (`campaigns-master.json`, `creatives-master.json`, `account-master.json`) use force-overwrite to handle same-minute re-runs.
- `config.json` keys are auto-migrated from v1 → v2 format on each run.

Pipeline outputs (in `runDir`): `account-health.json`, `budget-actions.json`, `funnel.json`, `trends.json`, `creative-analysis.json`, `creative-media.json`, `pipeline-status.json`, `recommendations.json` (optional — skipped if account lacks AI recommendations permission).

## Non-Obvious Behaviors

- `--since`/`--until` must be used together — specifying only one exits with code 2.
- `insights --level` defaults to match the ID flag used (`--campaign-id` → campaign, etc.). Pass `--level` explicitly to override.
- `--status` filter on list commands filters by `effective_status`, not raw `status` — these differ when budget-limited.
- Default `--limit` for list commands is 50.
- Auto-retry covers HTTP 429 and 5xx — exponential backoff up to 3 retries; `retryAfter` header honored.
- Budgets are in the account's minor currency unit (cents for USD, paisa for INR) — divide by 100 for display.
- `campaigns create` default status is `PAUSED` — campaigns do not go live automatically.
- Intel metrics use omni-first extraction (`omni_purchase` preferred over `purchase`) with base fallback. See `metrics.ts` for the full action-type priority.
- `insights` diagnostic ranking fields (`quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking`) are ad-level only — Meta rejects them for campaign/adset/account queries. They live in a separate `AD_INSIGHT_FIELDS` constant.
- Optional pipeline outputs (e.g., `recommendations.json`) must not be in `expectedFiles` — doing so causes `status: "partial"` for accounts that simply lack the required API permission.

## Output Format

- List commands: `{"data": [...], "has_more": false}` (with optional `"next_cursor"`)
- Single-item commands (get, create, update): plain objects `{"id": "...", ...}`
- Errors (stderr): `{"error": "CODE", "message": "...", "hint": "..."}`
- Always use `.data[]` not `.[]` when parsing list output with jq.
- `ads list`/`ads get` include flattened creative fields: `creative_id`, `creative_title`, `creative_body`, `creative_image_url`, `creative_thumbnail_url`.
- `intel run` returns `{"run_dir": "...", "status": "complete|partial", "files_produced": [...], "files_skipped": [...], "warnings": [...], "creatives": {"total_ads": N, "total_frames": N}}`. The `creatives` field is present only when ffmpeg extracted visual artifacts.

## Destructive Operations

`campaigns update`, `adsets update`, `ads update` with `--status PAUSED/DELETED/ARCHIVED` prompt for confirmation interactively. In scripts (non-TTY), pass `--force` to avoid exit code 2. `auth logout` and `uninstall` also require `--force` non-interactively.

## Exit Codes

- `0` — success
- `1` — runtime error (API failure, network)
- `2` — usage error (bad flags, missing required args, cancelled confirmation)
