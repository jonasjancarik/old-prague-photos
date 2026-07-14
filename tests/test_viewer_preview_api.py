import json
import hashlib
import hmac
import os
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import viewer.app as viewer_app


def _feature(xid: str, scan_previews: list[str] | None = None) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [14.42, 50.08]},
        "properties": {
            "id": xid,
            "group_id": f"group-{xid}",
            "scan_previews": scan_previews or [],
            "scan_count": len(scan_previews or []),
        },
    }


class ViewerPreviewApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.photos_path = self.root / "photos.geojson"
        self.previews_dir = self.root / "previews"
        self.data_dir = self.root / "data"
        self.corrections_path = self.data_dir / "corrections.jsonl"
        self.merges_path = self.data_dir / "merges.jsonl"
        self.group_review_votes_path = self.data_dir / "group_review_votes.jsonl"
        self.group_membership_events_path = (
            self.data_dir / "group_membership_events.jsonl"
        )
        self.previews_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self._original = {
            "PHOTOS_PATH": viewer_app.PHOTOS_PATH,
            "LOCAL_PREVIEWS_DIR": viewer_app.LOCAL_PREVIEWS_DIR,
            "DATA_DIR": viewer_app.DATA_DIR,
            "CORRECTIONS_PATH": viewer_app.CORRECTIONS_PATH,
            "MERGES_PATH": viewer_app.MERGES_PATH,
            "GROUP_REVIEW_VOTES_PATH": viewer_app.GROUP_REVIEW_VOTES_PATH,
            "GROUP_MEMBERSHIP_EVENTS_PATH": viewer_app.GROUP_MEMBERSHIP_EVENTS_PATH,
        }
        viewer_app.PHOTOS_PATH = self.photos_path
        viewer_app.LOCAL_PREVIEWS_DIR = self.previews_dir
        viewer_app.DATA_DIR = self.data_dir
        viewer_app.CORRECTIONS_PATH = self.corrections_path
        viewer_app.MERGES_PATH = self.merges_path
        viewer_app.GROUP_REVIEW_VOTES_PATH = self.group_review_votes_path
        viewer_app.GROUP_MEMBERSHIP_EVENTS_PATH = self.group_membership_events_path

        self._mtime = time.time()
        self._write_photos(
            [
                _feature("R2ONLY"),
                _feature("LOCALONLY"),
                _feature("FEATUREONLY", ["https://feature.example/p.jpg"]),
                _feature("NONE"),
                _feature("MUTATE", ["https://feature.example/old.jpg"]),
            ]
        )

        self._reset_caches()
        self.client = TestClient(viewer_app.app)

    def tearDown(self) -> None:
        viewer_app.PHOTOS_PATH = self._original["PHOTOS_PATH"]
        viewer_app.LOCAL_PREVIEWS_DIR = self._original["LOCAL_PREVIEWS_DIR"]
        viewer_app.DATA_DIR = self._original["DATA_DIR"]
        viewer_app.CORRECTIONS_PATH = self._original["CORRECTIONS_PATH"]
        viewer_app.MERGES_PATH = self._original["MERGES_PATH"]
        viewer_app.GROUP_REVIEW_VOTES_PATH = self._original[
            "GROUP_REVIEW_VOTES_PATH"
        ]
        viewer_app.GROUP_MEMBERSHIP_EVENTS_PATH = self._original[
            "GROUP_MEMBERSHIP_EVENTS_PATH"
        ]
        self._reset_caches()
        self.tmpdir.cleanup()

    def _reset_caches(self) -> None:
        viewer_app._photos_cache = None
        viewer_app._photos_cache_mtime = None
        viewer_app._xid_group_cache = None
        viewer_app._feature_preview_cache = None
        viewer_app._preview_url_cache = {}
        viewer_app._zoomify_cache = {}

    def _write_photos(self, features: list[dict]) -> None:
        payload = {"type": "FeatureCollection", "features": features}
        self.photos_path.write_text(
            json.dumps(payload, ensure_ascii=False),
            encoding="utf-8",
        )
        self._mtime += 1.0
        os.utime(self.photos_path, (self._mtime, self._mtime))

    def _append_jsonl(self, path: Path, payload: dict) -> None:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False))
            handle.write("\n")

    def test_preview_url_prefers_r2(self) -> None:
        with patch.dict(os.environ, {"R2_TILES_BASE": "https://r2.example/tiles"}, clear=False):
            with patch.object(viewer_app, "_url_exists", return_value=True) as exists:
                response = self.client.get("/api/preview-url", params={"xid": "R2ONLY"})
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["source"], "r2")
                self.assertEqual(
                    payload["url"],
                    "https://r2.example/tiles/R2ONLY/scan_0/TileGroup0/0-0-0.jpg",
                )

                response_cached = self.client.get(
                    "/api/preview-url", params={"xid": "R2ONLY"}
                )
                self.assertEqual(response_cached.status_code, 200)
                self.assertEqual(response_cached.json()["source"], "r2")
                self.assertEqual(exists.call_count, 1)

    def test_config_exposes_server_fullres_mode(self) -> None:
        response = self.client.get("/api/config")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("fullResDownloadMode"), "server")

    def test_preview_url_falls_back_to_local_cache(self) -> None:
        local_dir = self.previews_dir / "LOCALONLY"
        local_dir.mkdir(parents=True, exist_ok=True)
        local_file = local_dir / "scan_0.jpg"
        local_file.write_bytes(b"preview-bytes")

        with patch.dict(os.environ, {"R2_TILES_BASE": "https://r2.example/tiles"}, clear=False):
            with patch.object(viewer_app, "_url_exists", return_value=False):
                response = self.client.get("/api/preview-url", params={"xid": "LOCALONLY"})
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["source"], "local_cache")
                self.assertEqual(
                    payload["url"],
                    "/api/preview-local?xid=LOCALONLY&scanIndex=0",
                )

        local_response = self.client.get(
            "/api/preview-local", params={"xid": "LOCALONLY", "scanIndex": 0}
        )
        self.assertEqual(local_response.status_code, 200)
        self.assertEqual(local_response.content, b"preview-bytes")

    def test_preview_url_falls_back_to_feature_preview(self) -> None:
        with patch.dict(os.environ, {"R2_TILES_BASE": "https://r2.example/tiles"}, clear=False):
            with patch.object(viewer_app, "_url_exists", return_value=False):
                response = self.client.get(
                    "/api/preview-url", params={"xid": "FEATUREONLY"}
                )
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["source"], "feature_preview")
                self.assertEqual(payload["url"], "https://feature.example/p.jpg")

    def test_preview_url_returns_none_when_missing_everywhere(self) -> None:
        with patch.dict(os.environ, {"R2_TILES_BASE": "https://r2.example/tiles"}, clear=False):
            with patch.object(viewer_app, "_url_exists", return_value=False):
                response = self.client.get("/api/preview-url", params={"xid": "NONE"})
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["source"], "none")
                self.assertEqual(payload["url"], "")

    def test_preview_local_rejects_invalid_inputs(self) -> None:
        bad_xid = self.client.get(
            "/api/preview-local", params={"xid": "../evil", "scanIndex": 0}
        )
        self.assertEqual(bad_xid.status_code, 400)

        bad_scan = self.client.get(
            "/api/preview-local", params={"xid": "LOCALONLY", "scanIndex": -1}
        )
        self.assertEqual(bad_scan.status_code, 400)

    def test_preview_cache_invalidation_when_geojson_changes(self) -> None:
        with patch.dict(os.environ, {"R2_TILES_BASE": "https://r2.example/tiles"}, clear=False):
            with patch.object(viewer_app, "_url_exists", return_value=False):
                first = self.client.get("/api/preview-url", params={"xid": "MUTATE"})
                self.assertEqual(first.status_code, 200)
                self.assertEqual(first.json()["source"], "feature_preview")
                self.assertEqual(first.json()["url"], "https://feature.example/old.jpg")

                self._write_photos(
                    [
                        _feature("R2ONLY"),
                        _feature("LOCALONLY"),
                        _feature("FEATUREONLY", ["https://feature.example/p.jpg"]),
                        _feature("NONE"),
                        _feature("MUTATE", ["https://feature.example/new.jpg"]),
                    ]
                )

                second = self.client.get("/api/preview-url", params={"xid": "MUTATE"})
                self.assertEqual(second.status_code, 200)
                self.assertEqual(second.json()["source"], "feature_preview")
                self.assertEqual(second.json()["url"], "https://feature.example/new.jpg")

    def test_submit_correction_rejects_group_spoofing(self) -> None:
        payload = {
            "xid": "R2ONLY",
            "group_id": "group-LOCALONLY",
            "lat": 50.1,
            "lon": 14.4,
            "verdict": "wrong",
        }
        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            response = self.client.post("/api/corrections", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("Neplatná skupina", response.json().get("detail", ""))

    def test_submit_correction_rejects_unknown_xid(self) -> None:
        payload = {
            "xid": "UNKNOWN_XID",
            "lat": 50.1,
            "lon": 14.4,
            "verdict": "wrong",
        }
        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            response = self.client.post("/api/corrections", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("Neznámé xid", response.json().get("detail", ""))

    def test_submit_correction_accepts_resolved_merged_group(self) -> None:
        self._append_jsonl(
            self.merges_path,
            {
                "id": "merge_1",
                "group_id_a": "group-LOCALONLY",
                "group_id_b": "group-R2ONLY",
                "verdict": "same",
                "received_at": "2026-01-01T00:00:00+00:00",
            },
        )
        payload = {
            "xid": "R2ONLY",
            "group_id": "group-LOCALONLY",
            "verdict": "ok",
        }

        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            response = self.client.post("/api/corrections", json=payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accepted_group_id"], "group-LOCALONLY")
        record = json.loads(self.corrections_path.read_text(encoding="utf-8"))
        self.assertEqual(record["group_id"], "group-R2ONLY")

    def test_merge_undo_accepts_a_pair_that_now_has_one_root(self) -> None:
        self._append_jsonl(
            self.merges_path,
            {
                "id": "merge_1",
                "group_id_a": "group-LOCALONLY",
                "group_id_b": "group-R2ONLY",
                "verdict": "same",
                "received_at": "2026-01-01T00:00:00+00:00",
            },
        )

        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            response = self.client.post(
                "/api/merges",
                json={
                    "group_id_a": "group-LOCALONLY",
                    "group_id_b": "group-R2ONLY",
                    "verdict": "undo",
                },
            )

        self.assertEqual(response.status_code, 200)
        rows = [
            json.loads(line)
            for line in self.merges_path.read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(rows[-1]["verdict"], "undo")
        self.assertEqual(rows[-1]["group_id_a"], "group-LOCALONLY")
        self.assertEqual(rows[-1]["group_id_b"], "group-R2ONLY")

    def test_merge_undo_keeps_the_exact_historical_pair(self) -> None:
        self._append_jsonl(
            self.merges_path,
            {
                "id": "merge_1",
                "group_id_a": "group-FEATUREONLY",
                "group_id_b": "group-R2ONLY",
                "verdict": "different",
                "received_at": "2026-01-01T00:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.merges_path,
            {
                "id": "merge_2",
                "group_id_a": "group-LOCALONLY",
                "group_id_b": "group-R2ONLY",
                "verdict": "same",
                "received_at": "2026-01-01T00:01:00+00:00",
            },
        )

        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            response = self.client.post(
                "/api/merges",
                json={
                    "group_id_a": "group-FEATUREONLY",
                    "group_id_b": "group-R2ONLY",
                    "verdict": "undo",
                },
            )

        self.assertEqual(response.status_code, 200)
        rows = [
            json.loads(line)
            for line in self.merges_path.read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(rows[-1]["group_id_a"], "group-FEATUREONLY")
        self.assertEqual(rows[-1]["group_id_b"], "group-R2ONLY")

    def test_membership_move_does_not_transfer_historical_correction(self) -> None:
        self._append_jsonl(
            self.corrections_path,
            {
                "id": "correction_1",
                "xid": "R2ONLY",
                "group_id": "group-R2ONLY",
                "lat": 50.2,
                "lon": 14.2,
                "has_coordinates": True,
                "verdict": "wrong",
                "voter_key": "voter-a",
                "received_at": "2026-01-01T00:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.group_membership_events_path,
            {
                "id": "membership_1",
                "source_group_id": "group-R2ONLY",
                "target_group_id": "group-LOCALONLY",
                "assignments": ["R2ONLY"],
                "review_boundaries": {},
                "received_at": "2026-01-01T00:01:00+00:00",
            },
        )

        state = self.client.get("/api/review-state").json()

        self.assertEqual(state["resolvedGroupByXid"]["R2ONLY"], "group-LOCALONLY")
        self.assertEqual(state["groupCorrections"][0]["group_id"], "group-R2ONLY")

    def test_durable_voter_cookie_is_reused_across_corrections(self) -> None:
        payload = {"xid": "R2ONLY", "group_id": "group-R2ONLY", "verdict": "ok"}
        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            first = self.client.post("/api/corrections", json=payload)
            second = self.client.post("/api/corrections", json=payload)

        self.assertEqual(first.status_code, 200)
        self.assertIn("opp_voter_id=", first.headers.get("set-cookie", ""))
        rows = [
            json.loads(line)
            for line in self.corrections_path.read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(rows[0]["voter_key"], rows[1]["voter_key"])

    def test_independent_split_votes_create_curator_candidate(self) -> None:
        payload = {"group_id": "group-R2ONLY", "verdict": "split"}
        first_client = TestClient(viewer_app.app)
        second_client = TestClient(viewer_app.app)
        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            self.assertEqual(
                first_client.post("/api/group-review-votes", json=payload).status_code,
                200,
            )
            self.assertEqual(
                second_client.post("/api/group-review-votes", json=payload).status_code,
                200,
            )
            response = first_client.get("/api/group-review-votes")

        self.assertEqual(response.status_code, 200)
        state = next(
            item
            for item in response.json()["items"]
            if item["group_id"] == "group-R2ONLY"
        )
        self.assertEqual(state["split_votes"], 2)
        self.assertTrue(state["needs_split"])

    def test_fastapi_admin_can_apply_a_curator_group_split(self) -> None:
        first = _feature("R2ONLY")
        second = _feature("LOCALONLY")
        first["properties"]["group_id"] = "group-shared"
        second["properties"]["group_id"] = "group-shared"
        self._write_photos([first, second])
        self._append_jsonl(
            self.group_review_votes_path,
            {
                "id": "vote_1",
                "group_id": "group-shared",
                "verdict": "split",
                "voter_key": "voter-a",
                "received_at": "2026-01-01T10:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.group_review_votes_path,
            {
                "id": "vote_2",
                "group_id": "group-shared",
                "verdict": "split",
                "voter_key": "voter-b",
                "received_at": "2026-01-01T10:01:00+00:00",
            },
        )

        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            before = self.client.get("/api/admin/review")
            split = self.client.post(
                "/api/admin/group-membership",
                json={
                    "source_group_id": "group-shared",
                    "target_group_id": "series-curated-local",
                    "xids": ["LOCALONLY"],
                    "reason": "Different viewpoint",
                },
            )
            after = self.client.get("/api/admin/review")

        self.assertEqual(before.status_code, 200)
        before_payload = before.json()
        self.assertEqual(before_payload["counts"]["splitCandidates"], 1)
        self.assertEqual(
            before_payload["splitCandidates"][0]["xids"],
            ["LOCALONLY", "R2ONLY"],
        )
        self.assertEqual(
            before_payload["splitCandidates"][0]["members"][0]["xid"],
            "LOCALONLY",
        )
        self.assertEqual(
            len(before_payload["splitCandidates"][0]["vote_history"]),
            2,
        )
        self.assertEqual(split.status_code, 200)
        self.assertEqual(split.json()["moved_xids"], ["LOCALONLY"])
        self.assertEqual(
            split.json()["target_group_id"],
            "series-curated-local",
        )
        self.assertEqual(after.status_code, 200)
        self.assertEqual(after.json()["counts"]["splitCandidates"], 0)
        self.assertEqual(after.json()["counts"]["membershipEvents"], 1)
        self.assertEqual(
            after.json()["membershipHistory"][0]["xids"],
            ["LOCALONLY"],
        )
        state = self.client.get("/api/review-state").json()
        self.assertEqual(
            state["resolvedGroupByXid"]["LOCALONLY"],
            "series-curated-local",
        )
        self.assertEqual(
            state["resolvedGroupByXid"]["R2ONLY"],
            "group-shared",
        )
        event = json.loads(
            self.group_membership_events_path.read_text(encoding="utf-8")
        )
        self.assertEqual(event["review_boundaries"]["group-shared"], 2)

    def test_fastapi_admin_searches_existing_groups_and_reverses_a_full_move(self) -> None:
        source = _feature("R2ONLY")
        target = _feature("LOCALONLY")
        source["properties"]["group_id"] = "group-source"
        source["properties"]["description"] = "Source view"
        target["properties"]["group_id"] = "group-target"
        target["properties"]["description"] = "Old Town destination"
        self._write_photos([source, target])

        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            search = self.client.get(
                "/api/admin/groups",
                params={"query": "Old Town"},
            )
            moved = self.client.post(
                "/api/admin/group-membership",
                json={
                    "source_group_id": "group-source",
                    "target_group_id": "group-target",
                    "xids": ["R2ONLY"],
                    "reason": "Undo mistaken split",
                },
            )

        self.assertEqual(search.status_code, 200)
        self.assertEqual(search.json()["items"][0]["group_id"], "group-target")
        self.assertEqual(moved.status_code, 200)
        self.assertEqual(
            self.client.get("/api/review-state").json()["resolvedGroupByXid"]["R2ONLY"],
            "group-target",
        )

    def test_candidate_cursor_changes_after_existing_group_membership_move(self) -> None:
        first = _feature("R2ONLY")
        second = _feature("LOCALONLY")
        target = _feature("FEATUREONLY")
        first["properties"]["group_id"] = "group-source"
        second["properties"]["group_id"] = "group-source"
        target["properties"]["group_id"] = "group-target"
        self._write_photos([first, second, target])

        page = self.client.get(
            "/api/community-candidates",
            params={"flow": "location", "limit": 1},
        )
        self.assertEqual(page.status_code, 200)
        cursor = page.json()["nextCursor"]
        self.assertTrue(cursor)

        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            moved = self.client.post(
                "/api/admin/group-membership",
                json={
                    "source_group_id": "group-source",
                    "target_group_id": "group-target",
                    "xids": ["LOCALONLY"],
                },
            )
        self.assertEqual(moved.status_code, 200)

        stale = self.client.get(
            "/api/community-candidates",
            params={"flow": "location", "limit": 1, "cursor": cursor},
        )
        self.assertEqual(stale.status_code, 409)

    def test_group_review_votes_follow_current_merged_root(self) -> None:
        self._append_jsonl(
            self.merges_path,
            {
                "id": "merge_1",
                "group_id_a": "group-LOCALONLY",
                "group_id_b": "group-R2ONLY",
                "verdict": "same",
                "received_at": "2026-01-01T00:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.group_review_votes_path,
            {
                "id": "vote_1",
                "group_id": "group-R2ONLY",
                "verdict": "ok",
                "voter_key": "voter-a",
                "received_at": "2026-01-01T10:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.group_review_votes_path,
            {
                "id": "vote_2",
                "group_id": "group-LOCALONLY",
                "verdict": "ok",
                "voter_key": "voter-b",
                "received_at": "2026-01-01T10:01:00+00:00",
            },
        )

        response = self.client.get("/api/group-review-votes")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["count"], 1)
        item = response.json()["items"][0]
        self.assertEqual(item["group_id"], "group-LOCALONLY")
        self.assertEqual(item["ok_votes"], 2)
        self.assertTrue(item["done"])

        with patch.dict(os.environ, {"TURNSTILE_BYPASS": "1"}, clear=False):
            submitted = self.client.post(
                "/api/group-review-votes",
                json={"group_id": "group-R2ONLY", "verdict": "split"},
            )
        self.assertEqual(submitted.status_code, 200)
        self.assertEqual(
            submitted.json()["decision"]["group_id"],
            "group-LOCALONLY",
        )
        written = [
            json.loads(line)
            for line in self.group_review_votes_path.read_text(
                encoding="utf-8"
            ).splitlines()
        ]
        self.assertEqual(written[-1]["group_id"], "group-LOCALONLY")

    def test_admin_api_requires_configured_bearer_token(self) -> None:
        with patch.dict(
            os.environ,
            {"TURNSTILE_BYPASS": "0", "ADMIN_API_TOKEN": "admin-secret"},
            clear=False,
        ):
            denied = self.client.get("/api/admin/review")
            allowed = self.client.get(
                "/api/admin/review",
                headers={"Authorization": "Bearer admin-secret"},
            )

        self.assertEqual(denied.status_code, 401)
        self.assertEqual(allowed.status_code, 200)

    def test_admin_token_is_exchanged_for_httponly_session(self) -> None:
        public_client = TestClient(viewer_app.app, base_url="https://public.example")
        with patch.dict(
            os.environ,
            {"TURNSTILE_BYPASS": "0", "ADMIN_API_TOKEN": "admin-secret"},
            clear=False,
        ):
            login = public_client.post(
                "/api/admin/session",
                headers={"Origin": "https://public.example"},
                json={"token": "admin-secret"},
            )
            review = public_client.get("/api/admin/review")

        self.assertEqual(login.status_code, 200)
        set_cookie = login.headers.get("set-cookie", "")
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=strict", set_cookie)
        self.assertNotIn("admin-secret", set_cookie)
        self.assertEqual(review.status_code, 200)

    def test_admin_session_rejects_invalid_token(self) -> None:
        public_client = TestClient(viewer_app.app, base_url="https://public.example")
        with patch.dict(
            os.environ,
            {"TURNSTILE_BYPASS": "0", "ADMIN_API_TOKEN": "admin-secret"},
            clear=False,
        ):
            response = public_client.post(
                "/api/admin/session",
                headers={"Origin": "https://public.example"},
                json={"token": "wrong-token"},
            )

        self.assertEqual(response.status_code, 401)

    def test_admin_csv_neutralizes_spreadsheet_formulas(self) -> None:
        self._append_jsonl(
            self.corrections_path,
            {
                "id": "formula-1",
                "xid": "R2ONLY",
                "group_id": "group-R2ONLY",
                "verdict": "flag",
                "has_coordinates": False,
                "message": "=HYPERLINK(\"https://evil.example\")",
                "received_at": "2026-01-01T00:00:00+00:00",
            },
        )
        with patch.dict(
            os.environ,
            {"TURNSTILE_BYPASS": "0", "ADMIN_API_TOKEN": "admin-secret"},
            clear=False,
        ):
            response = self.client.get(
                "/api/admin/export",
                params={"format": "csv"},
                headers={"Authorization": "Bearer admin-secret"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("'=HYPERLINK", response.text)

    def test_bypass_session_fallback_is_not_valid_on_public_hosts(self) -> None:
        exp = int(time.time()) + 3600
        signature = hmac.new(
            b"dev-bypass", str(exp).encode("utf-8"), hashlib.sha256
        ).hexdigest()
        public_client = TestClient(viewer_app.app, base_url="https://public.example")
        public_client.cookies.set(
            viewer_app.SESSION_COOKIE_NAME,
            f"{exp}.{signature}",
        )
        with patch.dict(
            os.environ,
            {
                "TURNSTILE_BYPASS": "1",
                "TURNSTILE_SESSION_SECRET": "",
                "TURNSTILE_SECRET_KEY": "",
                "API_RATE_LIMIT_SECRET": "",
            },
            clear=False,
        ):
            response = public_client.post(
                "/api/corrections",
                headers={"Origin": "https://public.example"},
                json={"xid": "R2ONLY", "verdict": "ok"},
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Turnstile", response.json().get("detail", ""))

    def test_review_state_picks_latest_verdict_and_latest_coordinates_per_group(self) -> None:
        self._append_jsonl(
            self.merges_path,
            {
                "id": "merge_1",
                "group_id_a": "group-LOCALONLY",
                "group_id_b": "group-R2ONLY",
                "verdict": "same",
                "received_at": "2026-01-01T00:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.corrections_path,
            {
                "id": "1",
                "xid": "R2ONLY",
                "group_id": "group-R2ONLY",
                "lat": 50.10,
                "lon": 14.10,
                "has_coordinates": True,
                "verdict": "wrong",
                "received_at": "2026-01-01T10:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.corrections_path,
            {
                "id": "2",
                "xid": "LOCALONLY",
                "group_id": "group-LOCALONLY",
                "lat": 50.20,
                "lon": 14.20,
                "has_coordinates": True,
                "verdict": "wrong",
                "received_at": "2026-01-01T11:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.corrections_path,
            {
                "id": "3",
                "xid": "R2ONLY",
                "group_id": "group-R2ONLY",
                "has_coordinates": False,
                "verdict": "ok",
                "received_at": "2026-01-01T12:00:00+00:00",
            },
        )

        response = self.client.get("/api/review-state")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        resolved = payload["resolvedGroupByXid"]
        self.assertEqual(resolved["R2ONLY"], "group-LOCALONLY")
        self.assertEqual(resolved["LOCALONLY"], "group-LOCALONLY")

        group_items = payload["groupCorrections"]
        self.assertEqual(len(group_items), 1)
        correction = group_items[0]
        self.assertEqual(correction["group_id"], "group-LOCALONLY")
        self.assertEqual(correction["verdict"], "ok")
        self.assertEqual(correction["lat"], 50.2)
        self.assertEqual(correction["lon"], 14.2)
        self.assertTrue(correction["has_coordinates"])
        self.assertIn("group-LOCALONLY", payload["doneGroupIds"])

    def test_review_state_honors_merge_undo_as_latest_event(self) -> None:
        self._append_jsonl(
            self.merges_path,
            {
                "id": "merge_1",
                "group_id_a": "group-LOCALONLY",
                "group_id_b": "group-R2ONLY",
                "verdict": "same",
                "received_at": "2026-01-01T00:00:00+00:00",
            },
        )
        self._append_jsonl(
            self.merges_path,
            {
                "id": "merge_2",
                "group_id_a": "group-LOCALONLY",
                "group_id_b": "group-R2ONLY",
                "verdict": "undo",
                "received_at": "2026-01-01T00:01:00+00:00",
            },
        )

        response = self.client.get("/api/review-state")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        resolved = payload["resolvedGroupByXid"]
        self.assertEqual(resolved["R2ONLY"], "group-R2ONLY")
        self.assertEqual(resolved["LOCALONLY"], "group-LOCALONLY")
        self.assertEqual(payload["mergeDecisions"], [])

    def test_community_candidates_are_paginated(self) -> None:
        response = self.client.get(
            "/api/community-candidates?flow=location&cursor=0&limit=2"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["items"]), 2)
        self.assertEqual(payload["limit"], 2)
        self.assertRegex(
            payload["nextCursor"],
            r"^v[A-Za-z0-9_-]+:r\d+:2$",
        )
        self.assertEqual(payload["total"], 5)

    def test_duplicate_candidates_reject_unknown_focus_group(self) -> None:
        response = self.client.get(
            "/api/community-candidates",
            params={"flow": "duplicate", "group_id": "attacker-value"},
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
