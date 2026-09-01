---
name: creative-signal
description: >
  This skill should be used when the user says "creative signal", "which creatives hook",
  "hook rate", "hold rate", "what makes our video ads work", "creative attributes",
  "tag my ads", "creative brief", or wants to know which creative attributes (format, hook,
  sound, pacing, emotion) correlate with video retention on Meta ads. Not for budget
  decisions, ROAS analysis, or writing ad copy — use meta-ads-intel for account performance.
license: MIT
compatibility: >
  Requires meta-ads CLI >= 0.19 (npm i -g meta-ads@^0.19), ffmpeg/ffprobe, Python >= 3.10
  with a skill-local venv, and a Gemini API key. Node.js >= 20. macOS/Linux.
argument-hint: "[last_7d | last_14d | last_30d | reconfigure | backfill]"
metadata:
  author: gupsammy
  version: "1.0"
---

# Creative Signal

Correlate creative attributes with **hook rate** (3-second views ÷ impressions) and **hold rate** (thruplay ÷ 3-second views) across every video ad that delivered in the window. Scripts pull metrics into a local SQLite store, tag each creative once (Gemini `gemini-3.1-flash-lite` + ffmpeg features), and compute per-attribute lift with explicit confidence. The agent reads `signals.json` and authors `brief.md` — judgment on top, never re-derived math.

Arguments: `$ARGUMENTS` — optional window (default `last_14d`; valid `last_7d`, `last_14d`, `last_30d`), or `reconfigure`, or `backfill`.

**v1 makes no revenue or ROAS claim.** Hook and hold are attention proxies. State this in every brief.

## Data Architecture

```
<skill-dir>/                          # this folder — Base directory injected when the skill loads
├── .venv/                            # created by onboarding; every script runs via .venv/bin/python
├── scripts/                          # run.py orchestrates the rest
└── references/                       # onboarding.md, taxonomy.md, gemini-prompt.md

~/.meta-ads-intel/                    # shared home with meta-ads-intel (one auth, one brand context)
├── config.json                       # account_id, currency, brand targets — shared, read-only here
├── brand-context.md                  # product/audience/hooks — shared, read for the brief
├── creative-signal.env               # GEMINI_API_KEY=… (mode 0600)
├── creative-signal.db                # SQLite: ad×day metrics + tag-once cache (mode 0600)
├── creatives/                        # CLI video snapshot — REPLACED on every --keep-video pull; never rely on it
└── creative-signal/
    └── runs/<until>/
        ├── signals.json              ── agent reads ──
        ├── run-status.json           ── agent reads ──
        └── brief.md                  ── agent writes ──
```

The store is the durable artifact. Videos are transient; the `asset_hash` → tags row in `creative_tags` is what survives.

## Process

### 0. Mode Gate

Run in order; the first match wins.

1. `$ARGUMENTS` contains `reconfigure` → read `references/onboarding.md` → "Reconfigure Mode". STOP when it prints "Config updated".
2. `$ARGUMENTS` contains `backfill` → read `references/onboarding.md` → "Phase 6: Backfill" only, then STOP.
3. Any of these is missing → **ONBOARDING MODE**: read `references/onboarding.md` and follow it completely. Onboarding ends with the first analysis run and STOPS.
   - `~/.meta-ads-intel/config.json` with a valid `account_id`
   - `~/.meta-ads-intel/creative-signal.env` containing `GEMINI_API_KEY` (or the env var set)
   - `<skill-dir>/.venv/bin/python`
   - a non-empty store: `<skill-dir>/.venv/bin/python <skill-dir>/scripts/store.py status` reports `metric_rows > 0`
4. Otherwise → **ANALYSIS MODE**: continue to Step 1.

Check each of the four prerequisites with one command; do not guess. Onboarding is idempotent and skips satisfied phases, so entering it with a partial setup is safe.

### 1. Load Context

Read `~/.meta-ads-intel/brand-context.md` (product, audience, proven hooks). If missing, proceed and note "brand context unavailable — recommendations are attribute-level only" in the brief.

Read `references/taxonomy.md` — every attribute the scripts can emit, its source, and how to interpret it. Do not invent attributes that are not listed there.

### 2. Run the Pipeline

```bash
<skill-dir>/.venv/bin/python <skill-dir>/scripts/run.py --window $ARGUMENTS
```

Omit `--window` when `$ARGUMENTS` is empty (defaults to `last_14d`). The run is idempotent: sync fetches only the gap plus a trailing 7 days (Meta revises recent days), videos download only for ads that still need one, Gemini is called once per new `asset_hash`. A second run minutes later does nothing but recompute correlation.

Steps inside `run.py`: sync → assets → deterministic → gemini → correlate. A bad video or a missing Gemini key degrades to a warning; the run still produces `signals.json`.

Runtime: first run after backfill tags every video (≈3 s + 9k tokens per ad; 200 ads ≈ 10 min). Steady state ≈ 30 s.

Exit codes:
- `0` — read `out_dir`, `signals_file`, and `warnings` from the JSON on stdout.
- `3` — store empty. Tell the user, then run `references/onboarding.md` → Phase 7 (backfill). Do not loop.
- `1` — read the single stderr line. `Another pull instance is running` means `/meta-ads-intel` holds the lock; the script already retried for 5 minutes — ask the user to wait for it and rerun. `API access blocked` / `Session has expired` are auth problems: report and stop; suggest `meta-ads setup`. Anything else: report verbatim and stop.

Read `run-status.json` from `out_dir`. Surface these before analysis:
- `steps.sync.new_ads` > 0 — new creatives entered the account this window; say how many.
- `steps.assets.unavailable` non-empty — ads whose video could not be fetched (deleted, or over the CLI's 500-ad cap); they contribute metrics but no attributes.
- `steps.gemini.skipped` true — no attributes from Gemini this run; the brief covers deterministic features only. Say why (`reason`).
- `steps.gemini.failed` > 0 — creatives Gemini could not parse after retries; rerun with `--retry-failed` later via `scripts/tag_gemini.py`.
- `steps.correlate` — `n_eligible` of `n_ads`, and the strong/directional/anecdotal counts. These are the headline numbers of the brief.

### 3. Read signals.json

Structure (spec §10):

```json
{ "run":      { "window", "since", "until", "account_id", "n_ads", "n_eligible", "n_tests",
                "min_impressions", "model", "shopify_enabled", "confidence_rules" },
  "ads":      [ { "ad_id", "ad_name", "campaign_name", "impressions", "video_view", "thruplay",
                  "hook_rate", "hold_rate", "attributes": {...}, "flags": [...], "eligible" } ],
  "signals":  [ { "attribute": "first3s_content=face", "metric": "hook_rate",
                  "n_group", "n_rest", "mean_with", "mean_without", "lift_pct",
                  "effect_size", "p_value", "q_value", "confidence" } ],
  "warnings": [ "..." ] }
```

`signals` is pre-sorted: strong → directional → anecdotal, then by |effect_size|. Read it top-down.

Attribute labels: categorical `key=value` (tested with-vs-rest); numeric `key>=<median>` (median split); booleans `key=true`. Every signal exists twice at most — once per metric (`hook_rate`, `hold_rate`).

Per-ad `flags` explain exclusions: `untagged` (no cached tags), `no_video_view` (image ad — no hook/hold possible), `partial_retention` (hold_rate unavailable — retention fields missing for part of the window; happens for days pulled before CLI 0.19), `below_min_impressions` (under 1000). Only `eligible: true` ads entered the tests.

### 4. Interpret

Confidence is the load-bearing field. Read `run.confidence_rules` and apply:

| confidence | treat as | say |
|---|---|---|
| `strong` | a finding | "Ads that open on a face hook 37% better (n=31 vs 56, d=0.61, p=0.018)" |
| `directional` | a lead worth a test | "Directional: UGC holds longer (n=9 vs 14, p=0.11) — test before betting on it" |
| `anecdotal` | a hypothesis only | mention at most 3, grouped, explicitly labelled anecdotal |

Rules that keep the brief honest:
- If `n_eligible < 20`, no signal can be strong — open the brief with that fact and frame everything as hypotheses.
- `q_value` is the Benjamini-Hochberg-adjusted p across all `n_tests`. If a strong signal has `q_value > 0.10`, say it may be a multiple-comparison artefact. Always state `n_tests` in Confidence & Caveats.
- `lift_pct` is relative (0.375 = +37.5%). Report `mean_with` vs `mean_without` as percentages alongside it so the absolute gap is visible.
- Hook and hold answer different questions. A hook signal is about the first 3 seconds (`first3s_content`, `hook_text`, `time_to_first_cut`, `energy_first3s`, `branding_first3s`). A hold signal is about the body (`cut_count`, `avg_shot_len`, `sound_mode`, `emotion`, `transcript` length). Do not attribute a hold signal to an opening choice.
- `tempo_bpm` and other audio-lane features are only meaningful when `sound_mode` includes music. Gate on it.
- Numeric splits: `cut_count>=7` means "ads at or above the median of 7 cuts". Say "more cuts than the median" rather than quoting the threshold as a target.
- A signal on `format_style=static` or `subject=text_graphic` with a tiny `n_group` usually means one outlier ad. Check `ads` for that group before reporting.
- Mirror pairs: a two-valued attribute is tested once. `faces_present=true` lifting hook by +20% implies `faces_present=false` at −20%; do not list both as separate findings.

Read `ads` to ground every reported signal in concrete examples: for each strong or directional signal, name the top 2 ads by the metric inside the group and 1 outside it. Quote `hook_text` verbatim where present — it is the most actionable attribute and is never tested statistically.

### 5. Write brief.md

Write `<out_dir>/brief.md`. Structure, in order, headers verbatim:

1. **Window & coverage** — window dates, `n_eligible` of `n_ads` ads, why the rest were excluded (from `flags` counts in `warnings`), tags source (`run.model`), and whether Gemini ran. One paragraph.
2. **What works** — strong signals first, then directional. One bullet per signal: attribute in plain words, metric, lift with means, n, confidence, two example ads with `hook_text` where it exists.
3. **What doesn't** — signals with negative lift, same format. Include the mirror reading of a positive finding only if it names a different actionable choice.
4. **Why** — 2–4 sentences connecting the signals to the brand context and the audience. This is the only interpretive section; label inference as inference.
5. **What to try next** — up to 3 recombination briefs. Each: the attribute combination to produce (drawn only from strong/directional signals), a hook line modelled on the best-performing `hook_text`, the format, and which metric it targets. Tie to products/audience from brand-context.md.
6. **Confidence & caveats** — always present, always these points: hook/hold are proxies with no revenue link claimed in v1; `n_tests` tests were run and `q_value` is the adjusted p; small groups; ads excluded and why; anything in `warnings` not already covered.

Numbers in the brief come from `signals.json` and `run-status.json` only. Never compute a rate, mean, or lift yourself. If a number the brief needs is absent, say it is absent.

Length target: 400–800 words. Fewer signals, shorter brief — do not pad an anecdotal-only run.

### 6. Return

Print: window, `n_eligible`/`n_ads`, counts by confidence, the single highest-value finding in one line, and both paths (`signals.json`, `brief.md`).

If this is the first analysis after onboarding, offer the optional daily pre-warm scheduler once (`references/onboarding.md` → "Optional: daily pre-warm"). Never offer it again in later runs.

## Rules

- Run every script through `<skill-dir>/.venv/bin/python`. System `python3` lacks `google-genai`.
- Never read `~/.meta-ads-intel/creatives/` directly — it is a snapshot the CLI replaces. Read `ads[].attributes` from `signals.json` instead.
- Never read `~/.meta-ads-intel/data/` — that belongs to meta-ads-intel.
- Never call `meta-ads intel fetch-daily --keep-video` yourself. `run.py` decides when a video pull is needed; a manual call re-downloads every video and wipes the snapshot.
- Never re-run correlation, recompute means, or count `ads[]` by hand. All counts are in `run-status.json` and `run.*`.
- Never make a revenue, ROAS, purchase, or CPA claim from this skill's output. Redirect budget questions to `/meta-ads-intel`.
- `GEMINI_API_KEY` is read from the env or `creative-signal.env` by the scripts. Never echo it, never write it into a run dir or brief.
- Spend data is sensitive: `run.py` sets umask 077. Do not copy outputs outside `~/.meta-ads-intel/` unless the user asks.
