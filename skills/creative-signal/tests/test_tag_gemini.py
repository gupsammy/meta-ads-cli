"""tag_gemini tests — fake client throughout; the one live test self-skips unless
CREATIVE_SIGNAL_LIVE=1 and a GEMINI_API_KEY are present.

Run:  python3 -m unittest discover -s skills/creative-signal/tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import store  # noqa: E402
import tag_gemini as tg  # noqa: E402
from test_store import raw_row  # noqa: E402

NOSLEEP = lambda s: None  # noqa: E731

GOOD = {
    "format_style": "ugc", "subject": "person_and_product", "first3s_content": "face",
    "hook_text": "Stop scrolling", "cta_text": "Shop now", "cta_style": "both",
    "sound_mode": "voice_and_music", "emotion": "excitement",
    "faces_present": True, "branding_first3s": False, "transcript": "Stop scrolling. Shop now.",
}


class _Err(Exception):
    def __init__(self, code, msg="boom"):
        super().__init__(msg)
        self.code = code


class FakeClient:
    """Scripted Gemini: `responses` is a list of str (model text) or Exception (raised)."""

    def __init__(self, responses, *, file_states=("ACTIVE",)):
        self.responses = list(responses)
        self.calls: list[dict] = []
        self.uploads = 0
        self.deleted: list[str] = []
        self._states = list(file_states)
        self.models = SimpleNamespace(generate_content=self._gen)
        self.files = SimpleNamespace(upload=self._upload, get=self._get, delete=self._delete)

    def _gen(self, *, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return SimpleNamespace(text=r, usage_metadata=SimpleNamespace(total_token_count=100))

    def _upload(self, *, file, config=None):
        self.uploads += 1
        return self._file()

    def _get(self, *, name):
        return self._file()

    def _delete(self, *, name):
        self.deleted.append(name)

    def _file(self):
        state = self._states.pop(0) if len(self._states) > 1 else self._states[0]
        return SimpleNamespace(name="files/abc", state=SimpleNamespace(name=state))


def _fake_video(path: Path, size: int = 1024) -> Path:
    path.write_bytes(b"\0" * size)
    return path


# ── validation ──────────────────────────────────────────────────────────────────
class ValidateTest(unittest.TestCase):
    def test_good_payload_normalises(self):
        out = tg.validate_tags({**GOOD, "format_style": " UGC ", "cta_text": "  ", "extra": 1})
        self.assertEqual(out["format_style"], "ugc")
        self.assertIsNone(out["cta_text"], "empty text → None, never a correlatable ''")
        self.assertNotIn("extra", out, "unknown keys must not leak into the attribute space")
        self.assertEqual(set(out), set(tg.TAG_KEYS))

    def test_bad_enum_missing_key_and_bad_bool_all_reported(self):
        bad = {**GOOD, "emotion": "angry", "faces_present": "yes"}
        del bad["subject"]
        with self.assertRaises(tg.TagError) as cm:
            tg.validate_tags(bad)
        msg = str(cm.exception)
        for frag in ("emotion='angry'", "subject=None", "faces_present='yes'"):
            self.assertIn(frag, msg)

    def test_string_bools_accepted(self):
        out = tg.validate_tags({**GOOD, "faces_present": "true", "branding_first3s": "False"})
        self.assertIs(out["faces_present"], True)
        self.assertIs(out["branding_first3s"], False)

    def test_parse_tolerates_fences_rejects_garbage(self):
        self.assertEqual(tg.parse_response_text('```json\n{"a": 1}\n```'), {"a": 1})
        for bad in ("", None, "not json", "[1,2]"):
            with self.assertRaises(tg.TagError):
                tg.parse_response_text(bad)

    def test_schema_matches_taxonomy(self):
        self.assertEqual(set(tg.RESPONSE_SCHEMA["required"]), set(tg.TAG_KEYS))
        for k, allowed in tg.ENUMS.items():
            self.assertEqual(tg.RESPONSE_SCHEMA["properties"][k]["enum"], list(allowed))
        # texts are per-ad context only — correlate must never test them
        try:
            import correlate  # lands with PR #36; until then this half of the check skips
        except ImportError:
            self.skipTest("correlate.py not on this branch yet")
        for k in tg.TEXTS:
            self.assertIn(k, correlate.NON_ATTRIBUTES)
        self.assertIn("tag_failed", correlate.NON_ATTRIBUTES)


# ── key resolution ──────────────────────────────────────────────────────────────
class KeyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-key-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_env_wins_then_file_then_error(self):
        f = self.tmp / "creative-signal.env"
        f.write_text("# comment\nexport GEMINI_API_KEY='from-file'\nOTHER=x\n")
        self.assertEqual(tg.load_api_key({"GEMINI_API_KEY": "from-env"}, f), "from-env")
        self.assertEqual(tg.load_api_key({}, f), "from-file")
        with self.assertRaises(tg.ApiUnavailable) as cm:
            tg.load_api_key({}, self.tmp / "missing.env")
        self.assertIn("GEMINI_API_KEY", str(cm.exception))


# ── tag_video: retries, inline vs files, failure classes ────────────────────────
class TagVideoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-tv-"))
        self.small = _fake_video(self.tmp / "small.mp4")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_happy_path_inline_temperature_zero_schema(self):
        c = FakeClient([json.dumps(GOOD)])
        tags, tokens = tg.tag_video(c, self.small, sleep=NOSLEEP)
        self.assertEqual(tags["first3s_content"], "face")
        self.assertEqual(tokens, 100)
        self.assertEqual(c.uploads, 0, "≤ INLINE_MAX_BYTES must go inline")
        cfg = c.calls[0]["config"]
        self.assertEqual(cfg.temperature, 0.0)
        self.assertEqual(cfg.response_mime_type, "application/json")
        self.assertEqual(c.calls[0]["model"], tg.MODEL)

    def test_malformed_then_valid_retries_with_correction(self):
        c = FakeClient(["nope", json.dumps({**GOOD, "emotion": "angry"}), json.dumps(GOOD)])
        tags, tokens = tg.tag_video(c, self.small, sleep=NOSLEEP)
        self.assertEqual(tags["emotion"], "excitement")
        self.assertEqual(len(c.calls), 3)
        self.assertEqual(tokens, 300, "every attempt is billed and must be counted")
        self.assertIn("rejected", c.calls[1]["contents"][1])
        self.assertIn("emotion='angry'", c.calls[2]["contents"][1])

    def test_three_malformed_is_tag_error(self):
        c = FakeClient(["x", "y", "z", json.dumps(GOOD)])
        with self.assertRaises(tg.TagError):
            tg.tag_video(c, self.small, sleep=NOSLEEP)
        self.assertEqual(len(c.calls), tg.MAX_JSON_RETRIES + 1, "spec §8: ≤2 retries")

    def test_429_retried_then_ok(self):
        slept = []
        c = FakeClient([_Err(429), _Err(503), json.dumps(GOOD)])
        tags, _ = tg.tag_video(c, self.small, sleep=slept.append)
        self.assertEqual(tags["format_style"], "ugc")
        self.assertEqual(slept, [2.0, 4.0])

    def test_persistent_api_error_is_api_unavailable_not_tag_error(self):
        c = FakeClient([_Err(429)] * 10)
        with self.assertRaises(tg.ApiUnavailable):
            tg.tag_video(c, self.small, sleep=NOSLEEP)
        self.assertEqual(len(c.calls), tg.API_RETRIES + 1)

    def test_400_not_retried(self):
        c = FakeClient([_Err(400, "bad request"), json.dumps(GOOD)])
        with self.assertRaises(tg.ApiUnavailable):
            tg.tag_video(c, self.small, sleep=NOSLEEP)
        self.assertEqual(len(c.calls), 1)

    def test_large_file_uses_files_api_waits_active_and_cleans_up(self):
        big = _fake_video(self.tmp / "big.mp4", tg.INLINE_MAX_BYTES + 1)
        c = FakeClient([json.dumps(GOOD)], file_states=("PROCESSING", "PROCESSING", "ACTIVE"))
        tags, _ = tg.tag_video(c, big, sleep=NOSLEEP)
        self.assertEqual(c.uploads, 1)
        self.assertEqual(c.deleted, ["files/abc"])
        self.assertIs(c.calls[0]["contents"][0].state.name, "ACTIVE")

    def test_failed_upload_state_is_api_unavailable(self):
        big = _fake_video(self.tmp / "big.mp4", tg.INLINE_MAX_BYTES + 1)
        c = FakeClient([json.dumps(GOOD)], file_states=("FAILED",))
        with self.assertRaises(tg.ApiUnavailable):
            tg.tag_video(c, big, sleep=NOSLEEP)
        self.assertEqual(c.calls, [], "no generate call for a failed upload")

    def test_missing_file(self):
        with self.assertRaises(tg.ApiUnavailable):
            tg.tag_video(FakeClient([]), self.tmp / "nope.mp4", sleep=NOSLEEP)


# ── store-driven run ────────────────────────────────────────────────────────────
class TagUntaggedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-tu-"))
        self.conn = store.connect(self.tmp / "t.db")
        rows = [raw_row(a, "2026-08-20") for a in ("a1", "a2", "a3", "a4", "a5")]
        store.ingest_daily(self.conn, rows, "2026-08-20", "2026-08-20")
        self.v1 = _fake_video(self.tmp / "v1.mp4")
        self.v3 = _fake_video(self.tmp / "v3.mp4")
        store.set_ad_asset(self.conn, "a1", "cr1", "h1", str(self.v1))
        store.set_ad_asset(self.conn, "a2", "cr1", "h1", str(self.v1))      # shares creative with a1
        store.set_ad_asset(self.conn, "a3", "cr3", "h3", str(self.v3))
        store.set_ad_asset(self.conn, "a4", "cr4", "h4", str(self.tmp / "gone.mp4"))  # stale snapshot
        # a5: never fetched (asset_hash NULL) → not a Gemini candidate

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_dedupes_by_hash_writes_cache_and_skips_missing_video(self):
        c = FakeClient([json.dumps(GOOD), json.dumps({**GOOD, "format_style": "studio"})])
        res = tg.tag_untagged(self.conn, c, sleep=NOSLEEP)
        self.assertEqual(res.candidates, 4, "a1..a4 have assets; a5 has none")
        self.assertEqual(res.calls, 2, "a1+a2 share h1 → one call")
        self.assertEqual(res.shared, 1)
        self.assertEqual(sorted(res.tagged), ["h1", "h3"])
        self.assertEqual([s["ad_id"] for s in res.skipped], ["a4"])
        self.assertIn("fetch_assets", res.skipped[0]["reason"])
        self.assertEqual(store.get_tags(self.conn, "h1")["tags"]["format_style"], "ugc")
        self.assertEqual(store.get_tags(self.conn, "h1")["tagger_model"], tg.MODEL)
        self.assertEqual(store.get_tags(self.conn, "h3")["tags"]["format_style"], "studio")
        # second run: everything cached, zero calls
        res2 = tg.tag_untagged(self.conn, FakeClient([]), sleep=NOSLEEP)
        self.assertEqual(res2.calls, 0)
        self.assertEqual([s["ad_id"] for s in res2.skipped], ["a4"])

    def test_deterministic_only_row_still_gets_gemini_tags(self):
        store.upsert_tags(self.conn, "h1", deterministic={"features": {"cut_count": 3}})
        c = FakeClient([json.dumps(GOOD), json.dumps(GOOD)])
        res = tg.tag_untagged(self.conn, c, sleep=NOSLEEP)
        self.assertIn("h1", res.tagged)
        t = store.get_tags(self.conn, "h1")
        self.assertEqual(t["deterministic"]["features"]["cut_count"], 3, "partial upsert must keep it")
        self.assertEqual(t["tags"]["subject"], "person_and_product")

    def test_tag_failed_written_and_not_retried_unless_asked(self):
        c = FakeClient(["x", "y", "z", json.dumps(GOOD)])
        res = tg.tag_untagged(self.conn, c, sleep=NOSLEEP)
        self.assertEqual(res.failed, ["h1"])
        self.assertEqual(res.tagged, ["h3"])
        self.assertEqual(store.get_tags(self.conn, "h1")["tags"], {"tag_failed": True})
        self.assertTrue(res.errors[0]["error"].startswith("tag_failed"))
        res2 = tg.tag_untagged(self.conn, FakeClient([]), sleep=NOSLEEP)
        self.assertEqual(res2.calls, 0, "tag_failed is cached — no silent re-billing")
        res3 = tg.tag_untagged(self.conn, FakeClient([json.dumps(GOOD)]), retry_failed=True, sleep=NOSLEEP)
        self.assertEqual(res3.tagged, ["h1"])
        self.assertEqual(store.get_tags(self.conn, "h1")["tags"]["hook_text"], "Stop scrolling")

    def test_api_error_leaves_ad_untagged_for_next_run(self):
        c = FakeClient([_Err(429)] * 4 + [json.dumps(GOOD)])
        res = tg.tag_untagged(self.conn, c, sleep=NOSLEEP)
        self.assertEqual(res.tagged, ["h3"])
        self.assertEqual(res.failed, [])
        self.assertIsNone(store.get_tags(self.conn, "h1"), "quota trouble must not poison the cache")
        self.assertEqual(res.errors[0]["ad_id"], "a1")
        self.assertEqual(len(store.untagged_ads(self.conn, need="tags")), 3, "a1, a2 (h1) + a4 remain")

    def test_max_caps_calls_and_dry_run_writes_nothing(self):
        res = tg.tag_untagged(self.conn, FakeClient([json.dumps(GOOD)]), max_ads=1, sleep=NOSLEEP)
        self.assertEqual(res.calls, 1)
        self.assertTrue(any("--max 1" in s["reason"] for s in res.skipped))
        dry = tg.tag_untagged(self.conn, None, dry_run=True, sleep=NOSLEEP)
        self.assertTrue(dry.dry_run)
        self.assertEqual(dry.calls, 1, "h1 cached from the capped run; h3 remains")
        self.assertIsNone(store.get_tags(self.conn, "h3"))

    def test_store_selector_need_variants(self):
        store.upsert_tags(self.conn, "h1", tags=GOOD)
        store.upsert_tags(self.conn, "h3", deterministic={"features": {}})
        need_tags = {a["ad_id"] for a in store.untagged_ads(self.conn, need="tags")}
        need_det = {a["ad_id"] for a in store.untagged_ads(self.conn, need="deterministic")}
        legacy = {a["ad_id"] for a in store.untagged_ads(self.conn)}
        self.assertEqual(need_tags, {"a3", "a4"})
        self.assertEqual(need_det, {"a1", "a2", "a4"})
        self.assertEqual(legacy, {"a4", "a5"}, "no-hash or no-row only")
        with self.assertRaises(ValueError):
            store.untagged_ads(self.conn, need="bogus")


# ── CLI ─────────────────────────────────────────────────────────────────────────
class CliTest(unittest.TestCase):
    def test_print_prompt_and_dry_run_need_no_key(self):
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        env.pop("GEMINI_API_KEY", None)
        tmp = Path(tempfile.mkdtemp(prefix="cs-cli-"))
        try:
            env["CREATIVE_SIGNAL_DB"] = str(tmp / "cli.db")
            env["HOME"] = str(tmp)  # no ~/.meta-ads-intel/creative-signal.env either
            p = subprocess.run([sys.executable, str(SCRIPTS / "tag_gemini.py"), "--print-prompt"],
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("first3s_content", p.stdout)
            p = subprocess.run([sys.executable, str(SCRIPTS / "tag_gemini.py"), "--dry-run"],
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(json.loads(p.stdout)["candidates"], 0)
            p = subprocess.run([sys.executable, str(SCRIPTS / "tag_gemini.py"), "--video", str(tmp / "x.mp4")],
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 1)
            self.assertIn("GEMINI_API_KEY", p.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ── live (opt-in) ───────────────────────────────────────────────────────────────
@unittest.skipUnless(os.environ.get("CREATIVE_SIGNAL_LIVE") == "1" and os.environ.get("GEMINI_API_KEY")
                     and shutil.which("ffmpeg"), "set CREATIVE_SIGNAL_LIVE=1 + GEMINI_API_KEY (+ffmpeg)")
class LiveTest(unittest.TestCase):
    def test_real_call_on_lavfi_fixture_validates(self):
        from test_deterministic import _build_fixture
        tmp = Path(tempfile.mkdtemp(prefix="cs-live-"))
        try:
            v = tmp / "fixture.mp4"
            _build_fixture(v, with_audio=True)
            tags, tokens = tg.tag_video(tg.make_client(), v)
            self.assertEqual(set(tags), set(tg.TAG_KEYS))
            self.assertIn(tags["format_style"], tg.ENUMS["format_style"])
            self.assertIs(tags["faces_present"], False, "test pattern has no faces")
            self.assertGreater(tokens, 0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
