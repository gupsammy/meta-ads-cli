"""creative-signal Gemini tagger (spec §7 taxonomy, §8 contract).

One call per *creative* (asset_hash), never per ad: several ads can share one video and a
creative never changes, so the tag-once cache in creative_tags means Gemini only ever sees
new assets. Whole native video goes in (audio + frames); a strict JSON object comes out.

Failure semantics — two different outcomes, deliberately:
  • malformed / schema-invalid output after MAX_JSON_RETRIES retries → the cache row is
    written as {"tag_failed": true}. The ad still participates in correlation through its
    deterministic features; correlate.py never treats tag_failed as an attribute.
    `--retry-failed` re-attempts those rows (e.g. after a prompt or model change).
  • API trouble (quota, 5xx, network, upload never ACTIVE) after API_RETRIES → nothing is
    written. The ad stays untagged and the next run picks it up. A quota hiccup must never
    poison the cache.

Key: GEMINI_API_KEY env var, else ~/.meta-ads-intel/creative-signal.env (KEY=VALUE lines).

CLI:
  tag_gemini.py                      tag every ad with a fetched asset but no Gemini tags
  tag_gemini.py --since 2026-08-01   only ads seen on/after that date
  tag_gemini.py --max 50             cap calls this run (default 200)
  tag_gemini.py --retry-failed       also re-attempt tag_failed rows
  tag_gemini.py --dry-run            list candidates, no API calls
  tag_gemini.py --video path.mp4     one-shot: tag a file, print JSON (no store)
  tag_gemini.py --print-prompt       show the exact prompt + schema sent to the model
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402

MODEL = "gemini-3.1-flash-lite"
TEMPERATURE = 0.0                      # spec §8; classification, not generation
INLINE_MAX_BYTES = 15 * 1024 * 1024    # inline request limit is 20 MB total; keep headroom
MAX_JSON_RETRIES = 2                   # spec §8: ≤2 retries on malformed JSON, then tag_failed
API_RETRIES = 3                        # 429 / 5xx / transport, exponential backoff
BACKOFF_S = (2.0, 4.0, 8.0)
FILE_POLL_S = 2.0
FILE_TIMEOUT_S = 300.0
DEFAULT_MAX_ADS = 200
ENV_FILE = Path.home() / ".meta-ads-intel" / "creative-signal.env"

# ── taxonomy (spec §7, Gemini half) ─────────────────────────────────────────────
ENUMS: dict[str, tuple[str, ...]] = {
    "format_style": ("ugc", "studio", "motion", "static"),
    "subject": ("person", "product", "person_and_product", "text_graphic", "other"),
    "first3s_content": ("face", "product", "text", "scene", "logo", "other"),
    "cta_style": ("none", "spoken", "on_screen", "both"),
    "sound_mode": ("voice_only", "music_only", "voice_and_music", "ambient_or_sfx", "none"),
    "emotion": ("excitement", "humor", "calm", "urgency", "aspiration", "trust", "neutral"),
}
BOOLS = ("faces_present", "branding_first3s")
TEXTS = ("hook_text", "cta_text", "transcript")   # verbatim; "" → None; never correlated
TAG_KEYS = (*ENUMS, *BOOLS, *TEXTS)

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        **{k: {"type": "STRING", "enum": list(v)} for k, v in ENUMS.items()},
        **{k: {"type": "BOOLEAN"} for k in BOOLS},
        **{k: {"type": "STRING"} for k in TEXTS},
    },
    "required": list(TAG_KEYS),
}

PROMPT = """You are tagging a paid social video ad (Meta/Instagram) for creative analysis.
Watch and listen to the whole video, then return ONE JSON object with exactly these keys.
Every enum value must be copied exactly. Do not add keys, comments or markdown.

format_style — how it was produced:
  ugc = handheld / phone-shot / creator talking to camera, unpolished
  studio = professionally lit and shot, product or model photography feel
  motion = motion graphics / animation / kinetic text dominates
  static = a still image (or near-still) with little or no motion
subject — what is on screen most of the time:
  person | product | person_and_product | text_graphic | other
first3s_content — the dominant thing visible in the FIRST 3 SECONDS only:
  face = a human face fills or leads the frame
  product = the product/garment is the focus
  text = large on-screen text/headline is the focus
  scene = an environment or b-roll without a clear face/product/text focus
  logo = brand logo / brand card
  other
hook_text — the exact words used to open the ad in the first ~3 seconds, spoken OR on-screen,
  verbatim. Empty string if there are none.
cta_text — the exact call-to-action words (e.g. "Shop now", "Link in bio"), verbatim, spoken
  or on-screen. Empty string if there is none.
cta_style — none | spoken | on_screen | both  (how the CTA is delivered)
sound_mode — voice_only | music_only | voice_and_music | ambient_or_sfx | none
  (voice = speech or voiceover; music = a music track; ambient_or_sfx = sound but no speech
  and no music; none = silent / no audio track)
emotion — the single dominant emotional register the ad aims for:
  excitement | humor | calm | urgency | aspiration | trust | neutral
faces_present — true if any human face is clearly visible at any point.
branding_first3s — true if a logo or brand name is visible or spoken within the first 3 seconds.
transcript — every spoken word, verbatim, in order. If there is no speech, the on-screen text in
  order instead. Empty string if neither.

Return the JSON object only."""


class TagError(Exception):
    """Model output unusable after retries → caller writes tag_failed."""


class ApiUnavailable(Exception):
    """API/transport failure after retries → caller leaves the ad untagged."""


# ── key + client ────────────────────────────────────────────────────────────────
def parse_env_file(path: str | os.PathLike) -> dict[str, str]:
    """Minimal KEY=VALUE reader (comments, blank lines, optional `export `, quotes)."""
    out: dict[str, str] = {}
    try:
        text = Path(path).read_text()
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def load_api_key(env: dict | None = None, env_file: str | os.PathLike = ENV_FILE) -> str:
    env = os.environ if env is None else env
    key = env.get("GEMINI_API_KEY") or parse_env_file(env_file).get("GEMINI_API_KEY")
    if not key:
        raise ApiUnavailable(
            f"GEMINI_API_KEY not set — export it or add GEMINI_API_KEY=... to {env_file}")
    return key


def make_client(api_key: str | None = None):
    from google import genai  # lazy: keeps --dry-run / --print-prompt / tests import-free
    return genai.Client(api_key=api_key or load_api_key())


# ── output validation ───────────────────────────────────────────────────────────
_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.S)


def parse_response_text(text: str | None) -> dict:
    if not text or not text.strip():
        raise TagError("empty response")
    cleaned = _FENCE.sub("", text)
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise TagError(f"malformed JSON: {e.msg} at {e.pos}") from None
    if not isinstance(obj, dict):
        raise TagError(f"expected a JSON object, got {type(obj).__name__}")
    return obj


def validate_tags(obj: dict) -> dict:
    """Enforce the §7 contract and normalise: enums exact, bools real bools, texts
    stripped with "" → None. Unknown keys are dropped (they would otherwise become
    correlation attributes). Raises TagError listing every problem at once so the retry
    message can name them."""
    problems: list[str] = []
    out: dict = {}
    for k, allowed in ENUMS.items():
        v = obj.get(k)
        if isinstance(v, str) and v.strip().lower() in allowed:
            out[k] = v.strip().lower()
        else:
            problems.append(f"{k}={v!r} not in {list(allowed)}")
    for k in BOOLS:
        v = obj.get(k)
        if isinstance(v, bool):
            out[k] = v
        elif isinstance(v, str) and v.strip().lower() in ("true", "false"):
            out[k] = v.strip().lower() == "true"
        else:
            problems.append(f"{k}={v!r} must be true/false")
    for k in TEXTS:
        v = obj.get(k)
        if v is None or isinstance(v, str):
            out[k] = (v or "").strip() or None
        else:
            problems.append(f"{k} must be a string")
    if problems:
        raise TagError("; ".join(problems))
    return out


# ── Gemini plumbing ─────────────────────────────────────────────────────────────
def _is_retryable(exc: Exception) -> bool:
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code == 429 or code >= 500
    return exc.__class__.__name__ in ("ConnectError", "ReadTimeout", "TimeoutError",
                                      "ConnectionError", "RemoteProtocolError")


def _with_api_retries(fn, *, what: str, sleep=time.sleep):
    last: Exception | None = None
    for attempt in range(API_RETRIES + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — classify below
            if not _is_retryable(e) or attempt == API_RETRIES:
                last = e
                break
            last = e
            sleep(BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)])
    raise ApiUnavailable(f"{what}: {last.__class__.__name__}: {last}") from last


def _wait_active(client, f, *, poll_s=FILE_POLL_S, timeout_s=FILE_TIMEOUT_S, sleep=time.sleep):
    deadline = time.monotonic() + timeout_s
    while True:
        state = getattr(getattr(f, "state", None), "name", str(getattr(f, "state", "")))
        if state == "ACTIVE":
            return f
        if state == "FAILED":
            raise ApiUnavailable(f"file {f.name} processing FAILED")
        if time.monotonic() >= deadline:
            raise ApiUnavailable(f"file {f.name} not ACTIVE after {timeout_s:.0f}s")
        sleep(poll_s)
        f = client.files.get(name=f.name)


def _video_part(client, path: Path, *, sleep=time.sleep):
    """Returns (content_part, cleanup). Small files go inline (one round trip); larger ones
    through the Files API, which must reach ACTIVE before it can be referenced."""
    from google.genai import types
    size = path.stat().st_size
    if size <= INLINE_MAX_BYTES:
        return types.Part.from_bytes(data=path.read_bytes(), mime_type="video/mp4"), (lambda: None)
    f = _with_api_retries(lambda: client.files.upload(file=str(path)), what="upload", sleep=sleep)
    f = _wait_active(client, f, sleep=sleep)

    def cleanup() -> None:
        try:
            client.files.delete(name=f.name)
        except Exception:  # noqa: BLE001 — best-effort; files expire after 48h anyway
            pass
    return f, cleanup


def _generate(client, part, prompt: str, *, model: str, sleep=time.sleep):
    from google.genai import types
    cfg = types.GenerateContentConfig(
        temperature=TEMPERATURE,
        response_mime_type="application/json",
        response_schema=RESPONSE_SCHEMA,
    )
    return _with_api_retries(
        lambda: client.models.generate_content(model=model, contents=[part, prompt], config=cfg),
        what="generate_content", sleep=sleep)


def _usage(resp) -> int:
    um = getattr(resp, "usage_metadata", None)
    return int(getattr(um, "total_token_count", 0) or 0)


def tag_video(client, path: str | os.PathLike, *, model: str = MODEL,
              sleep=time.sleep) -> tuple[dict, int]:
    """Tag one video. Returns (tags, total_tokens). Raises TagError when the model cannot
    produce a valid object within MAX_JSON_RETRIES retries, ApiUnavailable on API trouble."""
    p = Path(path)
    if not p.is_file():
        raise ApiUnavailable(f"video not found: {p}")
    part, cleanup = _video_part(client, p, sleep=sleep)
    tokens = 0
    try:
        prompt = PROMPT
        last: TagError | None = None
        for attempt in range(MAX_JSON_RETRIES + 1):
            resp = _generate(client, part, prompt, model=model, sleep=sleep)
            tokens += _usage(resp)
            try:
                return validate_tags(parse_response_text(getattr(resp, "text", None))), tokens
            except TagError as e:
                last = e
                prompt = (f"{PROMPT}\n\nYour previous answer was rejected: {e}. "
                          "Return the corrected JSON object only.")
        raise TagError(f"invalid output after {MAX_JSON_RETRIES + 1} attempts: {last}")
    finally:
        cleanup()


# ── store-driven run ────────────────────────────────────────────────────────────
@dataclass
class TagResult:
    model: str
    candidates: int = 0
    calls: int = 0
    tagged: list[str] = field(default_factory=list)     # asset_hashes written with tags
    failed: list[str] = field(default_factory=list)     # asset_hashes written tag_failed
    shared: int = 0                                     # ads covered by an earlier call this run
    skipped: list[dict] = field(default_factory=list)   # {ad_id, reason} — nothing written
    errors: list[dict] = field(default_factory=list)    # {ad_id, asset_hash, error} — API, nothing written
    tokens: int = 0
    dry_run: bool = False

    def to_dict(self) -> dict:
        return {"model": self.model, "candidates": self.candidates, "calls": self.calls,
                "tagged": len(self.tagged), "failed": len(self.failed), "shared_ads": self.shared,
                "skipped": self.skipped, "errors": self.errors, "tokens": self.tokens,
                "dry_run": self.dry_run}


def tag_untagged(conn, client=None, *, since: str | None = None, max_ads: int = DEFAULT_MAX_ADS,
                 retry_failed: bool = False, model: str = MODEL, dry_run: bool = False,
                 tagger=tag_video, sleep=time.sleep) -> TagResult:
    """Tag every ad that has a fetched asset but no Gemini tags. Dedupes by asset_hash so a
    creative shared by N ads costs one call. `max_ads` caps *calls* this run; whatever is left
    is picked up next run (the cache makes re-runs free)."""
    res = TagResult(model=model, dry_run=dry_run)
    ads = store.untagged_ads(conn, since, need="tags", retry_failed=retry_failed)
    res.candidates = len(ads)
    done: dict[str, str] = {}   # asset_hash → "tagged" | "failed" | "error"
    for ad in ads:
        h, vp = ad["asset_hash"], ad.get("video_path")
        if h in done:
            res.shared += 1
            continue
        if not vp or not Path(vp).is_file():
            res.skipped.append({"ad_id": ad["ad_id"], "reason": f"video missing: {vp or '(no path)'} — re-run fetch_assets"})
            continue
        if res.calls >= max_ads:
            res.skipped.append({"ad_id": ad["ad_id"], "reason": f"--max {max_ads} reached"})
            continue
        if dry_run:
            res.calls += 1
            done[h] = "tagged"
            res.tagged.append(h)
            continue
        if client is None:
            client = make_client()
        res.calls += 1
        try:
            tags, tokens = tagger(client, vp, model=model, sleep=sleep)
            res.tokens += tokens
            store.upsert_tags(conn, h, creative_id=ad.get("creative_id"), tags=tags, tagger_model=model)
            done[h] = "tagged"
            res.tagged.append(h)
        except TagError as e:
            store.upsert_tags(conn, h, creative_id=ad.get("creative_id"),
                              tags={"tag_failed": True}, tagger_model=model)
            done[h] = "failed"
            res.failed.append(h)
            res.errors.append({"ad_id": ad["ad_id"], "asset_hash": h, "error": f"tag_failed: {e}"})
        except ApiUnavailable as e:
            done[h] = "error"
            res.errors.append({"ad_id": ad["ad_id"], "asset_hash": h, "error": str(e)})
    return res


# ── CLI ─────────────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="creative-signal: Gemini creative tagger")
    ap.add_argument("--db", help="SQLite path (default $CREATIVE_SIGNAL_DB or ~/.meta-ads-intel/creative-signal.db)")
    ap.add_argument("--since", help="only ads last seen on/after YYYY-MM-DD")
    ap.add_argument("--max", type=int, default=DEFAULT_MAX_ADS, help=f"max Gemini calls this run (default {DEFAULT_MAX_ADS})")
    ap.add_argument("--retry-failed", action="store_true", help="re-attempt assets flagged tag_failed")
    ap.add_argument("--dry-run", action="store_true", help="list candidates; no API calls, no writes")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--video", help="one-shot: tag this file and print JSON (store untouched)")
    ap.add_argument("--print-prompt", action="store_true")
    a = ap.parse_args(argv)

    if a.print_prompt:
        print(PROMPT)
        print("\n--- response_schema ---")
        print(json.dumps(RESPONSE_SCHEMA, indent=2))
        return 0
    try:
        if a.video:
            tags, tokens = tag_video(make_client(), a.video, model=a.model)
            print(json.dumps({"model": a.model, "tokens": tokens, "tags": tags}, indent=2))
            return 0
        conn = store.connect(a.db)
        res = tag_untagged(conn, since=a.since, max_ads=a.max, retry_failed=a.retry_failed,
                           model=a.model, dry_run=a.dry_run)
        print(json.dumps(res.to_dict(), indent=2))
        return 0
    except (TagError, ApiUnavailable) as e:
        print(f"tag_gemini: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
