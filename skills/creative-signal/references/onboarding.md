# First-Run Onboarding

Triggered when the Mode Gate finds any prerequisite missing. Seven phases: install, auth + account, brand context, Gemini key, write config, backfill, first run. Each phase starts by checking whether it is already satisfied — `~/.meta-ads-intel/` is shared with meta-ads-intel, so a user who onboarded there skips Phases 2–4 here.

Onboarding ends with the first analysis and STOPS. Do not offer a second window or further analysis in the same session.

During onboarding present numbers in context ("6 months ≈ 180 ad-days per ad") but draw no performance conclusions. Save judgment for the brief.

When asking questions: use AskUserQuestion (minimum 2 options). The tool adds "Other" automatically — do not add it. Offer a suggested value plus a meaningful alternative; never a bare yes/no.

Throughout, `<skill-dir>` is the base directory injected when this skill loaded. `PY` below means `<skill-dir>/.venv/bin/python`.

## Phase 1: Install

Check everything in one pass:
```bash
node --version; which meta-ads && meta-ads --version; which ffmpeg ffprobe; python3 --version
```

Requirements and fixes, in order. Stop at the first one that cannot be fixed and tell the user what to install.

1. **Node ≥ 20.** Missing → "Install Node.js 20+ from nodejs.org (or `brew install node`), then run /creative-signal again." Blocking.
2. **meta-ads ≥ 0.19.** Missing or older:
   ```bash
   npm i -g meta-ads@^0.19
   ```
   Permission error → suggest `sudo npm i -g meta-ads@^0.19` or nvm. `npx` is not sufficient — the scripts call `meta-ads` from PATH. Re-check `meta-ads --version` after install.
3. **ffmpeg + ffprobe — REQUIRED** (unlike meta-ads-intel). Missing → `brew install ffmpeg` (macOS) / `sudo apt install ffmpeg` (Debian/Ubuntu). Blocking: without it no video can be tagged, and this skill has nothing to correlate.
4. **Python ≥ 3.10.** Missing → `brew install python@3.12`. Blocking.
5. **Skill venv.** If `<skill-dir>/.venv/bin/python` is absent:
   ```bash
   python3 -m venv <skill-dir>/.venv && <skill-dir>/.venv/bin/pip install -q -r <skill-dir>/requirements.txt
   ```
   Verify: `PY -c "import google.genai"`. Failure → report pip's last lines; blocking.
6. **Advanced audio lane (optional, best-effort).** Attempt once, after 5 succeeds:
   ```bash
   <skill-dir>/.venv/bin/pip install -q -r <skill-dir>/requirements-advanced.txt
   ```
   Verify: `PY -c "import librosa"`. Failure → say "advanced audio features off — tempo/energy attributes will be blank" and continue. Never blocking, never retried.

Checkpoint: print the resolved versions (node, meta-ads, ffmpeg, python, audio lane on/off).

## Phase 2: Authentication

Skip if `meta-ads auth status -o json` reports a valid token AND `~/.meta-ads-intel/config.json` has `account_id`. Say "Using the existing meta-ads login for account <account_id>."

Otherwise run the checkpoint flow. Non-interactive shells cannot prompt for stdin, so never run bare `meta-ads setup`.

1. Ask for the Meta API access token via AskUserQuestion. Options: "I have a token ready", "Help me generate one" (→ point to Meta Business Settings → System Users → Generate token with `ads_read` + `ads_management`).
2. Save without selecting an account:
   ```bash
   meta-ads setup --non-interactive --token "<token>" --skip-account
   ```
3. **Checkpoint: auth verified.** `meta-ads auth status -o json` must show a valid token. Fail → ask for a new token; do not proceed. `API access blocked` (Graph error 200) is an app-level restriction, not a token problem — tell the user to check the app in developers.facebook.com and stop.
4. Discover accounts: `meta-ads accounts list -o json`. One account → use it. Several → AskUserQuestion listing name + id.
5. Set the default:
   ```bash
   meta-ads setup --non-interactive --token "<token>" --account-id "<account_id>"
   ```
6. **Checkpoint: account confirmed.** `meta-ads accounts get --account-id <account_id> -o json` returns name and currency. Store both for Phase 5.

## Phase 3: Brand Context

Skip if `~/.meta-ads-intel/brand-context.md` exists with a real `Product:` line. Say "Using the existing brand context." and show its Product line.

Otherwise run four separate AskUserQuestion interactions — never combined, never skipped because the website already answered it:

- **3a Website URL.** Options: the domain if known, "I don't have a website". If given, spawn a `general-purpose` subagent: "Analyze <URL>: homepage, sitemap or navigation to 5–8 product/collection pages, about page. Extract product categories, specific products with prices and materials, brand voice, audience signals, price tiers. Return a structured summary." Fall back to WebFetch, then to manual questions if the site is unreachable.
- **3b Product.** Pre-fill from the crawl: "It looks like you sell <…>. Accurate?" — or ask for a one-sentence description. Free text, not a category picker.
- **3c Price range and AOV.** Mandatory even when prices were crawled.
- **3d Target audience.** Age, location, interests; suggest from crawl signals.

Write `~/.meta-ads-intel/brand-context.md`:
```markdown
## Brand Context

- Product: <3b>
- Price point: <3c>
- Audience: <3d>
- Proven hook angles: Pending first creative-signal run
- Winning format: Pending first creative-signal run
- Weak format: Pending first creative-signal run
```
Every line gets a real value or the exact "Pending" text above. No TBD.

## Phase 4: Gemini Key

Skip if `GEMINI_API_KEY` is in the environment or `~/.meta-ads-intel/creative-signal.env` contains it. Verify the key works either way (step 3).

1. Ask via AskUserQuestion: "Paste your Gemini API key." Options: "I have a key", "Help me get one" (→ aistudio.google.com/apikey — free tier is enough; a full account tags for cents).
2. Write the file and lock it down:
   ```bash
   printf 'GEMINI_API_KEY=%s\n' '<key>' > ~/.meta-ads-intel/creative-signal.env && chmod 600 ~/.meta-ads-intel/creative-signal.env
   ```
3. **Checkpoint: key verified.**
   ```bash
   cd <skill-dir>/scripts && PY -c "import tag_gemini; c = tag_gemini.make_client(); print('ok', c.models.get(model='gemini-3.1-flash-lite').name)"
   ```
   Expected: `ok models/gemini-3.1-flash-lite`. Fail → the key is invalid or the model is unavailable to it; ask for another key. Do not proceed. (Keep the client bound to a name — a bare `make_client().models.get(...)` is garbage-collected mid-request.)

Never print the key back. Never write it anywhere except that file.

## Phase 5: Write Config

If `~/.meta-ads-intel/config.json` does not exist, create it so both skills can use it. Get the baseline:
```bash
meta-ads intel defaults --account-id <account_id> -o json
```
Output: `{"objectives": {"OUTCOME_SALES": {...}}, "total_spend": N, "objectives_detected": [...]}`.

Write:
```json
{
  "account_id": "<account_id>",
  "account_name": "<name from Phase 2>",
  "currency": "<currency from Phase 2>",
  "config_version": 2,
  "objectives_detected": ["<from defaults>"],
  "primary_objective": "<objective with highest spend>",
  "targets": { "global": { "max_frequency": 5.0, "min_spend": <1000 INR | 10 USD/EUR> },
               "<each objective>": { "<metric>": <current value from defaults> } },
  "creative_signal": { "backfill_months": null, "backfilled_at": null, "scheduler": "none" }
}
```
Per-objective target keys: OUTCOME_SALES `cpa`,`roas` · OUTCOME_TRAFFIC `cpc`,`ctr` · OUTCOME_AWARENESS `cpm`,`max_frequency` · OUTCOME_ENGAGEMENT `cpe` · OUTCOME_LEADS `cpl` · OUTCOME_APP_PROMOTION `cpi`. Current values become targets — tell the user: "I've set your current performance as baseline targets for meta-ads-intel; run `/meta-ads-intel reconfigure` to change them." This skill does not use targets.

If `config.json` already exists, add only the `creative_signal` block (preserve everything else byte-for-byte otherwise).

Create the run dir: `mkdir -p ~/.meta-ads-intel/creative-signal/runs`.

## Phase 6: Backfill

Skip if `PY <skill-dir>/scripts/store.py status` reports `metric_rows > 0` and the user did not ask for `backfill`. Print `min_date`, `max_date`, `ads`.

Otherwise ask via AskUserQuestion: "How much history should I load? Each 30 days is one Meta report (1–3 minutes)."
Options: "6 months (Recommended) — about 6 reports, 10–20 minutes", "3 months — faster, fewer ads reach a confident signal", "12 months — most history; older ads' videos are often no longer downloadable".

Run in the foreground with a long timeout:
```bash
PY <skill-dir>/scripts/backfill.py --months <N>
```
It walks 30-day chunks oldest → newest and upserts each as it lands. It is resumable: if it stops (network, sleep, Ctrl-C), run the same command again and it skips chunks already in `fetch_log`. Errors are one stderr line; `Another pull instance is running` means meta-ads-intel holds the lock — the script waits up to 5 minutes on its own.

Checkpoint: `PY <skill-dir>/scripts/store.py status` → `metric_rows > 0`. Report `ads`, `min_date`, `max_date`. Update `config.json` → `creative_signal.backfill_months` and `backfilled_at` (today, ISO).

Note to the user, once: "Historical metrics are complete. Videos for ads that have since been deleted may no longer be downloadable — those ads keep their numbers but get no creative attributes."

## Phase 7: First Run

```bash
PY <skill-dir>/scripts/run.py
```
This first run downloads every current video and tags each one — about 3 seconds per ad. Tell the user the expected wait from `store.py status` → `ads_untagged` × 3 s before starting.

Then follow `SKILL.md` Steps 2–6 exactly (read `run-status.json` and `signals.json`, write `brief.md`, return the summary). The brief is the deliverable of onboarding.

Update `brand-context.md`'s three "Pending" lines from the brief when the run produced at least one strong or directional signal: `Proven hook angles` ← top hook-rate signal + a quoted `hook_text`; `Winning format` ← best `format_style`/`first3s_content` signal; `Weak format` ← the most negative signal. Leave "Pending first creative-signal run" if everything was anecdotal.

### Optional: daily pre-warm

Offer once, after the first brief, via AskUserQuestion: "Want a daily background sync? Analysis then starts instantly because the day's metrics are already local. Skip it and each run syncs on demand — a few seconds longer, never wrong."
Options: "Skip for now (Recommended)", "Yes, set up the daily sync".

If yes — macOS: write `~/Library/LaunchAgents/com.creative-signal.sync.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.creative-signal.sync</string>
  <key>ProgramArguments</key><array>
    <string><skill-dir>/.venv/bin/python</string>
    <string><skill-dir>/scripts/sync.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>META_ADS_BIN</key><string><output of: which meta-ads></string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string><HOME>/.meta-ads-intel/creative-signal/sync.log</string>
  <key>StandardErrorPath</key><string><HOME>/.meta-ads-intel/creative-signal/sync.log</string>
</dict></plist>
```
Substitute absolute paths (launchd expands no `~`), then `launchctl load ~/Library/LaunchAgents/com.creative-signal.sync.plist`. `META_ADS_BIN` is required: launchd's PATH does not include npm globals.

Linux: `crontab -e` line `30 6 * * * <skill-dir>/.venv/bin/python <skill-dir>/scripts/sync.py >> ~/.meta-ads-intel/creative-signal/sync.log 2>&1` with `META_ADS_BIN=<path>` prefixed.

The scheduled job is `sync.py` — metrics only. It never downloads video; `run.py` does that when needed. Set `config.json` → `creative_signal.scheduler` to `"launchd"` / `"cron"`.

Final line: **"Setup complete. Run /creative-signal for your next analysis."** STOP.

---

## Reconfigure Mode

Triggered by `/creative-signal reconfigure`. Read `~/.meta-ads-intel/config.json` and ask via AskUserQuestion: "What would you like to change?"

- **Gemini key** → Phase 4 (overwrite the env file, verify).
- **Load more history** → Phase 6 with `--months <N>`; chunks already stored are skipped. `--force` only if the user says the data looks wrong.
- **Re-tag every creative** → confirm first (every video is re-fetched and re-tagged: cents, but minutes). Then clear the cache — `sqlite3 ~/.meta-ads-intel/creative-signal.db "DELETE FROM creative_tags; UPDATE ads SET asset_hash=NULL, video_path=NULL"` — and run `/creative-signal`.
- **Brand context** → Phase 3, rewriting only `brand-context.md`.
- **Daily sync on/off** → Phase 7 "Optional: daily pre-warm"; to remove, `launchctl unload` + delete the plist (or remove the crontab line) and set `scheduler` to `"none"`.
- **Meta account / token** → Phase 2. Changing the account means a different store: set `CREATIVE_SIGNAL_DB` to a new path or the old account's data mixes in. Say so before doing it.

After any change print what changed and: "Config updated. Run /creative-signal to analyze."
