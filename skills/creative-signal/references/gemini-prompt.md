# Gemini Tagging Contract

The authoritative prompt and response schema live in `scripts/tag_gemini.py` (`PROMPT`, `RESPONSE_SCHEMA`, `ENUMS`, `BOOLS`, `TEXTS`). Print the exact text the model receives with:

```bash
<skill-dir>/.venv/bin/python <skill-dir>/scripts/tag_gemini.py --print-prompt
```

This page explains the contract so the agent can reason about tag quality and failure modes. Do not paste a prompt from here into a call — the script is the only caller.

## Call shape

- Model `gemini-3.1-flash-lite`, `temperature 0`, `response_mime_type: application/json`, `response_schema` = the enum-constrained schema. One call per `asset_hash`; several ads sharing a creative share the call.
- Input: the whole native video. ≤ 15 MB inline in the request; larger files via the Files API (upload → wait ACTIVE → call → delete).
- Cost: ≈ 9k tokens per 30 s ad; 200 ads ≈ 1.8M tokens — cents on flash-lite. `--max` (default 200) caps calls per run.
- Key: `GEMINI_API_KEY` env var, else `~/.meta-ads-intel/creative-signal.env`.

## Why the prompt is shaped this way

- **Enums fixed in code, not in prose.** The schema rejects any value outside the list, and the parser drops unknown keys. Nothing the model improvises can become an attribute in `correlate.py`.
- **`first3s_content` is scoped to the first 3 seconds only.** Meta's `video_view` is a 3-second view; the attribute must describe exactly the window the metric measures.
- **`hook_text` and `transcript` are verbatim.** They are quoted in the brief and never tested, so paraphrase would be a loss with no gain. Empty string → stored as `null`.
- **`sound_mode` distinguishes voice / music / ambient / none** because `tempo_bpm` from the audio lane is only meaningful when music exists — the brief gates on this.
- **Single `emotion`.** One dominant register keeps the attribute categorical; a list could not be tested with-vs-rest.

## Two failure classes, two outcomes

| failure | what happens | recovery |
|---|---|---|
| Malformed / off-schema output after ≤ 2 retries (each retry names the rejected fields) | cache row written `{"tag_failed": true}`; ad has no Gemini attributes | `tag_gemini.py --retry-failed` |
| API trouble — 429, 5xx, transport — after 3 backoff retries | **nothing written**; ad stays untagged | next `run.py` retries automatically |

The split matters: a quota hiccup must never poison a permanent cache. A `tag_failed` row is a statement about the video; an API error is not.

## Validating a tag by eye

One-shot a single file without touching the store:

```bash
<skill-dir>/.venv/bin/python <skill-dir>/scripts/tag_gemini.py --video <path.mp4>
```

Check: `first3s_content` matches what a viewer sees before the 3 s mark; `hook_text` is exactly the opening words; `sound_mode` agrees with `has_audio` from the deterministic features (a `has_audio: false` video must tag `sound_mode: none`).

## Changing the taxonomy

Edit `ENUMS` / `BOOLS` / `TEXTS` in `tag_gemini.py` and the matching prompt lines, update `references/taxonomy.md`, and bump nothing else — the cache is keyed by `asset_hash`, so existing rows keep the old tags. To re-tag under a new taxonomy, delete the affected rows from `creative_tags` (or the whole table) and rerun; every video will be re-fetched and re-tagged at the usual cost.
