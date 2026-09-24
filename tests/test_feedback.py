import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import viewer.app as viewer_app


def test_local_feedback_is_idempotent_and_never_changes_review_state():
    with TemporaryDirectory() as directory, patch.dict("os.environ", {"TURNSTILE_BYPASS": "1"}):
        root = Path(directory)
        photos = root / "photos.geojson"
        photos.write_text(json.dumps({"type": "FeatureCollection", "features": [{
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [14.4, 50.1]},
            "properties": {"id": "X1", "group_id": "G1"},
        }]}), encoding="utf-8")
        with patch.multiple(viewer_app, PHOTOS_PATH=photos, DATA_DIR=root,
                            FEEDBACK_PATH=root / "feedback.jsonl",
                            FEEDBACK_STATUS_PATH=root / "feedback_status.jsonl",
                            CORRECTIONS_PATH=root / "corrections.jsonl"):
            viewer_app._photos_cache = None
            viewer_app._xid_group_cache = None
            client = TestClient(viewer_app.app)
            body = {"submission_id": "10000000-0000-4000-8000-000000000001",
                    "xid": "X1", "message": "Popis je nepřesný.", "email": "reader@example.com"}
            before = client.get("/api/review-state").json()
            first = client.post("/api/feedback", json=body)
            assert first.status_code == 200
            assert first.json()["id"].startswith("fb_")
            assert client.post("/api/feedback", json=body).json() == first.json()
            assert client.post("/api/feedback", json={**body, "message": "Jiný text"}).status_code == 409
            assert len((root / "feedback.jsonl").read_text().splitlines()) == 1
            assert "newsletter_opt_in" not in (root / "feedback.jsonl").read_text()
            assert client.get("/api/review-state").json() == before
            assert not (root / "corrections.jsonl").exists()
            items = client.get("/api/admin/feedback").json()["items"]
            assert len(items) == 1
            assert items[0]["email"] == body["email"]
            assert client.post("/api/admin/feedback", json={"id": first.json()["id"], "status": "resolved"}).status_code == 200
            assert client.get("/api/admin/feedback").json()["items"] == []
            assert client.post("/api/admin/feedback", json={"id": first.json()["id"], "status": "new"}).status_code == 200
            assert client.get("/api/admin/feedback").json()["items"][0]["resolved_at"] is None
            viewer_app._photos_cache = None
            viewer_app._xid_group_cache = None


def test_local_feedback_rejects_unknown_photo_and_blank_message():
    with TemporaryDirectory() as directory, patch.dict("os.environ", {"TURNSTILE_BYPASS": "1"}):
        root = Path(directory)
        photos = root / "photos.geojson"
        photos.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
        with patch.multiple(viewer_app, PHOTOS_PATH=photos, FEEDBACK_PATH=root / "feedback.jsonl"):
            viewer_app._photos_cache = None
            viewer_app._xid_group_cache = None
            client = TestClient(viewer_app.app)
            base = {"submission_id": "10000000-0000-4000-8000-000000000001", "xid": "X1", "message": "Valid text"}
            assert client.post("/api/feedback", json=base).status_code == 400
            assert client.post("/api/feedback", json={**base, "message": "  a "}).status_code == 400
            viewer_app._photos_cache = None
            viewer_app._xid_group_cache = None
