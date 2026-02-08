import json
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
        self.previews_dir.mkdir(parents=True, exist_ok=True)

        self._original = {
            "PHOTOS_PATH": viewer_app.PHOTOS_PATH,
            "LOCAL_PREVIEWS_DIR": viewer_app.LOCAL_PREVIEWS_DIR,
        }
        viewer_app.PHOTOS_PATH = self.photos_path
        viewer_app.LOCAL_PREVIEWS_DIR = self.previews_dir

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


if __name__ == "__main__":
    unittest.main()
