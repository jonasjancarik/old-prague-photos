import json
from tempfile import TemporaryDirectory
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
import viewer.app as viewer_app


def test_annotations_private_revision_history_and_unchanged_community():
    with TemporaryDirectory() as directory, patch.dict('os.environ', {'TURNSTILE_BYPASS': '1'}):
        root = Path(directory)
        photos = root / 'photos.geojson'
        photos.write_text(json.dumps({'features': [{'properties': {'id': 'X1', 'group_id': 'G1', 'description': 'Originál'}, 'geometry': {'type': 'Point', 'coordinates': [14.4, 50.1]}}]}))
        with patch.multiple(viewer_app, DATA_DIR=root, PHOTOS_PATH=photos):
            viewer_app._photos_cache = None
            viewer_app._xid_group_cache = None
            client = TestClient(viewer_app.app)
            body = {'xid': 'X1', 'expected_revision': 0, 'action': 'draft', 'public_text': '<script>ověření</script>', 'evidence_note': 'private@example.com', 'place_mode': 'keep', 'place_ids': [], 'disputed_place_ids': []}
            before = client.get('/api/review-state').json()
            assert client.post('/api/admin/photo-annotations', json=body).status_code == 200
            assert client.get('/api/photo-annotations').json() == {'metadata_revision': 0, 'items': []}
            assert client.post('/api/admin/photo-annotations', json={**body, 'expected_revision': 1, 'action': 'publish'}).status_code == 200
            public = client.get('/api/photo-annotations').json()
            assert public['metadata_revision'] == 1
            assert public['items'][0]['public_text'] == body['public_text']
            assert 'private@example.com' not in json.dumps(public)
            assert client.post('/api/admin/photo-annotations', json={**body, 'expected_revision': 2, 'public_text': 'Další draft'}).status_code == 200
            assert client.get('/api/photo-annotations').json() == public
            assert client.post('/api/admin/photo-annotations', json=body).status_code == 409
            assert client.post('/api/admin/photo-annotations', json={'xid': 'X1', 'expected_revision': 3, 'action': 'withdraw'}).status_code == 200
            assert client.get('/api/photo-annotations').json() == {'metadata_revision': 2, 'items': []}
            history = client.get('/api/admin/photo-annotations?xid=X1').json()
            assert len(history['history']) == 4
            assert history['photo']['description'] == 'Originál'
            assert client.get('/api/review-state').json() == before
            assert not (root / 'corrections.jsonl').exists()
            assert client.post('/api/admin/photo-annotations', json={**body, 'action': 'publish', 'expected_revision': 4, 'evidence_note': ''}).status_code == 400
            viewer_app._photos_cache = None
            viewer_app._xid_group_cache = None
