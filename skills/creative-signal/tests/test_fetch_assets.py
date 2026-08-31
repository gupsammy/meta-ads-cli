"""fetch_assets tests: candidate selection, snapshot registration (hash/creative_id/image/
unavailable sentinel), orchestration around an injected fetch, and the CLI.

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

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import fetch_assets as fa  # noqa: E402
import store  # noqa: E402
from test_store import raw_row  # noqa: E402


class Snapshot:
    """Builds what `fetch-daily --keep-video` leaves behind: <root>/data/creatives-master.json,
    <root>/creatives/manifest.json + per-ad dirs. `ads` = {ad_id: "video"|"image"|bytes}."""

    def __init__(self, root: Path):
        self.root, self.dd, self.cdir = root, root / "data", root / "creatives"

    def write(self, ads: dict[str, object], *, master: bool = True) -> None:
        shutil.rmtree(self.cdir, ignore_errors=True)
        self.dd.mkdir(parents=True, exist_ok=True)
        manifest, rows = [], []
        for ad_id, kind in ads.items():
            d = self.cdir / ad_id
            d.mkdir(parents=True)
            entry = {"ad_id": ad_id, "ad_name": f"Ad {ad_id}", "media_type": "image", "frames": [],
                     "artifacts_dir": str(d)}
            if kind == "image":
                (d / "image.png").write_bytes(b"PNG" + ad_id.encode())
            else:
                (d / "video.mp4").write_bytes(b"MP4" + (ad_id.encode() if kind == "video" else kind))
                entry.update({"media_type": "video", "video_path": str(d / "video.mp4")})
            manifest.append(entry)
            rows.append({"id": ad_id, "creative_id": f"cr-{ad_id}", "name": entry["ad_name"]})
        (self.cdir / "manifest.json").write_text(json.dumps(manifest))
        if master:
            (self.dd / "creatives-master.json").write_text(json.dumps({"data": rows}))


class FakeFetch:
    """Injected in place of sync.run_fetch_daily; writes a daily file and (optionally) a snapshot."""

    def __init__(self, snap: Snapshot, ads: dict | None = None, *, creatives: bool = True, daily_ads=("a1",)):
        self.snap, self.ads, self.creatives, self.daily_ads = snap, ads, creatives, daily_ads
        self.calls: list[tuple] = []

    def __call__(self, since, until, *, keep_video=False):
        self.calls.append((since, until, keep_video))
        f = self.snap.root / f"daily-{since}.json"
        f.write_text(json.dumps({"data": [raw_row(a, until) for a in self.daily_ads]}))
        out = {"run_dir": str(self.snap.root), "since": since, "until": until,
               "rows": len(self.daily_ads), "file": str(f)}
        if keep_video and self.creatives:
            if self.ads is not None:
                self.snap.write(self.ads)
            out["creatives"] = {"total_ads": len(self.ads or {}), "total_frames": 0,
                                "videos_retained": sum(1 for v in (self.ads or {}).values() if v != "image"),
                                "warnings": ["Ad creatives truncated at 500"]}
        return out


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cs-fa-"))
        self.snap = Snapshot(self.tmp)
        self.conn = store.connect(self.tmp / "t.db")

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def roster(self, *ad_ids, day="2026-08-20"):
        store.ingest_daily(self.conn, [raw_row(a, day) for a in ad_ids], day, day)

    def ad(self, ad_id):
        return dict(self.conn.execute("SELECT * FROM ads WHERE ad_id=?", (ad_id,)).fetchone())


class NeedsAssetTest(Base):
    def test_selection_rules(self):
        self.roster("none", "unav", "stale", "ready", "tagged")
        store.set_ad_asset(self.conn, "unav", None, fa.UNAVAILABLE, None)
        store.set_ad_asset(self.conn, "stale", "c", "h-stale", str(self.tmp / "gone.mp4"))
        v = self.tmp / "ok.mp4"; v.write_bytes(b"x")
        store.set_ad_asset(self.conn, "ready", "c", "h-ready", str(v))
        store.set_ad_asset(self.conn, "tagged", "c", "h-tagged", str(v))
        store.upsert_tags(self.conn, "h-tagged", tags={"format_style": "ugc"})
        ids = lambda **kw: sorted(a["ad_id"] for a in fa.needs_asset(self.conn, **kw))  # noqa: E731
        self.assertEqual(ids(), ["none", "stale"], "ready = a tag job, not a fetch job; tagged = done")
        self.assertEqual(ids(recheck=True), ["none", "stale", "unav"])


class RegisterTest(Base):
    def test_hash_creative_id_image_unknown_unavailable(self):
        self.roster("v1", "v2", "img", "gone")
        self.snap.write({"v1": b"same", "v2": b"same", "img": "image", "notyet": "video"})
        cands = fa.needs_asset(self.conn)
        r = fa.register_assets(self.conn, fa.load_manifest(self.snap.cdir),
                               fa.load_creative_lookup(self.snap.dd), cands)
        self.assertEqual(sorted(r.registered), ["v1", "v2"])
        self.assertEqual(self.ad("v1")["asset_hash"], self.ad("v2")["asset_hash"], "same bytes → shared creative")
        self.assertEqual(r.distinct_videos, 1)
        self.assertEqual(self.ad("v1")["creative_id"], "cr-v1")
        self.assertTrue(self.ad("v1")["video_path"].endswith("v1/video.mp4"))
        self.assertEqual(r.image_ads, ["img"])
        self.assertIsNone(self.ad("img")["video_path"])
        self.assertEqual(len(self.ad("img")["asset_hash"]), 64, "image hashed so it stops being a candidate")
        self.assertEqual(r.unknown_ads, 1, "in snapshot but never delivered → not in roster")
        self.assertEqual(r.unavailable, ["gone"])
        self.assertEqual(self.ad("gone")["asset_hash"], fa.UNAVAILABLE)
        # only real video ads reach the taggers
        self.assertEqual(sorted(a["ad_id"] for a in store.untagged_ads(self.conn, need="tags")), ["v1", "v2"])
        self.assertEqual(fa.needs_asset(self.conn), [], "everything resolved → next run fetches nothing")

    def test_registration_is_one_transaction_and_missing_artifacts_dir_is_not_an_image(self):
        self.roster("v1", "img", "odd")
        self.snap.write({"v1": "video", "img": "image", "odd": "image"})
        manifest = fa.load_manifest(self.snap.cdir)
        for e in manifest:
            if e["ad_id"] == "odd":
                del e["artifacts_dir"]   # never happens from creatives.ts; must not resolve to CWD/image.png
        stmts: list[str] = []
        self.conn.set_trace_callback(stmts.append)
        r = fa.register_assets(self.conn, manifest, {}, fa.needs_asset(self.conn))
        self.conn.set_trace_callback(None)
        self.assertEqual(sum(1 for q in stmts if q.strip().upper() == "COMMIT"), 1, "whole snapshot in one transaction")
        self.assertEqual(sum(1 for q in stmts if q.lstrip().upper().startswith("UPDATE")), 2)
        self.assertEqual((r.registered, r.image_ads), (["v1"], ["img"]))
        self.assertIsNone(self.ad("odd")["asset_hash"])

    def test_missing_master_and_manifest_are_tolerated(self):
        self.assertEqual(fa.load_manifest(self.snap.cdir), [])
        self.assertEqual(fa.load_creative_lookup(self.snap.dd), {})
        self.roster("v1")
        self.snap.write({"v1": "video"}, master=False)
        r = fa.register_assets(self.conn, fa.load_manifest(self.snap.cdir), {}, fa.needs_asset(self.conn))
        self.assertEqual(r.registered, ["v1"])
        self.assertIsNone(self.ad("v1")["creative_id"])


class FetchAssetsTest(Base):
    def test_no_candidates_means_no_download(self):
        self.roster("v1")
        v = self.tmp / "ok.mp4"; v.write_bytes(b"x")
        store.set_ad_asset(self.conn, "v1", "c", "h", str(v))
        f = FakeFetch(self.snap, {"v1": "video"})
        res = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, today="2026-08-31")
        self.assertFalse(res.fetched)
        self.assertEqual(f.calls, [], "§4.4: never re-download the whole account unless something needs it")
        self.assertEqual(res.to_dict()["candidates"], 0)

    def test_full_run_then_idempotent(self):
        self.roster("v1", "img", "gone")
        f = FakeFetch(self.snap, {"v1": "video", "img": "image", "new": "video"}, daily_ads=("v1", "new"))
        res = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, today="2026-08-31")
        self.assertEqual(f.calls, [("2026-08-24", "2026-08-31", True)])
        self.assertTrue(res.fetched)
        self.assertEqual(res.ingested_rows, 2, "the pull's metrics are ingested, not thrown away")
        self.assertEqual(res.cli["videos_retained"], 2)
        self.assertEqual(sorted(res.register.registered), ["new", "v1"], "'new' entered the roster via this pull")
        self.assertEqual(res.register.image_ads, ["img"])
        self.assertEqual(res.register.unavailable, ["gone"])
        self.assertTrue(any("truncated" in w for w in res.warnings))
        self.assertTrue(any("unavailable" in w for w in res.warnings))
        d = res.to_dict(); self.assertEqual((d["registered"], d["image_ads"], d["unavailable"]), (2, 1, ["gone"]))
        # second run: nothing left → no call
        res2 = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, today="2026-08-31")
        self.assertFalse(res2.fetched); self.assertEqual(len(f.calls), 1)
        # snapshot replaced by an intel run → stale path → re-fetch exactly once
        shutil.rmtree(self.snap.cdir)
        res3 = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, today="2026-08-31")
        self.assertTrue(res3.fetched); self.assertEqual(sorted(res3.register.registered), ["new", "v1"])

    def test_recheck_clears_sentinels_and_force_dry_run_register_only(self):
        self.roster("gone")
        store.set_ad_asset(self.conn, "gone", None, fa.UNAVAILABLE, None)
        f = FakeFetch(self.snap, {"gone": "video"})
        self.assertFalse(fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd).fetched, "sentinel is sticky")
        dry = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, recheck=True, dry_run=True)
        self.assertEqual((dry.candidates, dry.fetched, f.calls), (1, False, []))
        self.assertEqual(self.ad("gone")["asset_hash"], fa.UNAVAILABLE, "dry-run writes nothing")
        res = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, recheck=True, today="2026-08-31")
        self.assertEqual(res.register.registered, ["gone"])
        self.assertEqual(len(self.ad("gone")["asset_hash"]), 64)
        forced = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, force=True, today="2026-08-31")
        self.assertTrue(forced.fetched); self.assertEqual(len(f.calls), 2, "sticky 0 + dry 0 + recheck 1 + force 1")
        # register-only: no CLI, re-hash what is on disk
        (self.snap.cdir / "gone" / "video.mp4").write_bytes(b"changed")
        ro = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, force=True, register_only=True)
        self.assertFalse(ro.fetched); self.assertEqual(len(f.calls), 2)
        self.assertEqual(self.ad("gone")["asset_hash"], fa.sha256_file(self.snap.cdir / "gone" / "video.mp4"))

    def test_cli_without_video_step_warns_and_leaves_candidates(self):
        self.roster("v1")
        f = FakeFetch(self.snap, None, creatives=False, daily_ads=("v1",))
        res = fa.fetch_assets(self.conn, fetch=f, dd=self.snap.dd, today="2026-08-31")
        self.assertTrue(res.fetched)
        self.assertTrue(any("without the video step" in w for w in res.warnings))
        self.assertTrue(any("no manifest" in w for w in res.warnings))
        self.assertEqual(res.register.unavailable, ["v1"], "no snapshot at all → marked, not re-downloaded forever")

    def test_fetch_error_propagates(self):
        self.roster("v1")
        import sync

        def boom(since, until, *, keep_video=False):
            raise sync.FetchError("Another pull instance is running")
        with self.assertRaises(sync.FetchError):
            fa.fetch_assets(self.conn, fetch=boom, dd=self.snap.dd)


class CliTest(unittest.TestCase):
    def test_dry_run_and_bad_date(self):
        tmp = Path(tempfile.mkdtemp(prefix="cs-fa-cli-"))
        try:
            env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "CREATIVE_SIGNAL_DB": str(tmp / "c.db"),
                   "META_ADS_DATA_DIR": str(tmp / "data"), "META_ADS_BIN": str(tmp / "nope")}
            p = subprocess.run([sys.executable, str(SCRIPTS / "fetch_assets.py"), "--dry-run"],
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(json.loads(p.stdout)["candidates"], 0)
            p = subprocess.run([sys.executable, str(SCRIPTS / "fetch_assets.py"), "--today", "31-08-2026"],
                               capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 1); self.assertIn("fetch_assets:", p.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
