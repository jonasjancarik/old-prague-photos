import json
import hashlib
import os
import subprocess
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parents[1] / "viewer" / "static" / "data"
VERSION_SOURCES = [
    "photos.geojson",
    "orphan_xids.json",
    "similarity_candidates.json",
    "series_version_clusters.json",
]
OPTIONAL_VERSION_SOURCES = {
    "orphan_xids.json",
    "similarity_candidates.json",
    "series_version_clusters.json",
}


def load_json(name: str) -> dict:
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def test_static_viewer_data_has_valid_cross_file_references() -> None:
    photos = load_json("photos.geojson")
    features = photos.get("features", [])
    xids: set[str] = set()
    group_ids: set[str] = set()

    for feature in features:
        props = feature.get("properties") or {}
        xid = str(props.get("id") or "").strip()
        group_id = str(props.get("group_id") or "").strip()
        coordinates = (feature.get("geometry") or {}).get("coordinates") or []
        assert xid
        assert xid not in xids
        assert group_id
        assert len(coordinates) == 2
        lon, lat = coordinates
        assert -180 <= float(lon) <= 180
        assert -90 <= float(lat) <= 90
        xids.add(xid)
        group_ids.add(group_id)

    candidates = (
        load_json("similarity_candidates.json")
        if (DATA_DIR / "similarity_candidates.json").exists()
        else {"pairs": []}
    )
    for pair in candidates.get("pairs", []):
        assert str(pair.get("xid_a") or "") in xids
        assert str(pair.get("xid_b") or "") in xids
        assert str(pair.get("group_id_a") or "") in group_ids
        assert str(pair.get("group_id_b") or "") in group_ids

    clusters = (
        load_json("series_version_clusters.json")
        if (DATA_DIR / "series_version_clusters.json").exists()
        else {"clusters": []}
    )
    for cluster in clusters.get("clusters", []):
        assert str(cluster.get("series_id") or "") in group_ids
        cluster_xids = [str(value or "") for value in cluster.get("xids", [])]
        assert cluster_xids
        assert set(cluster_xids) <= xids
        assert str(cluster.get("representative_xid") or "") in cluster_xids


def test_community_data_version_matches_deployed_candidate_inputs() -> None:
    digest = hashlib.sha256()
    for name in VERSION_SOURCES:
        digest.update(name.encode())
        digest.update(b"\0")
        path = DATA_DIR / name
        if path.exists():
            digest.update(path.read_bytes())
        elif name in OPTIONAL_VERSION_SOURCES:
            digest.update(b"<missing>")
        else:
            raise AssertionError(f"Missing versioned community data: {name}")
        digest.update(b"\0")

    manifest = load_json("community-data-version.json")
    assert manifest.get("version") == f"sha256:{digest.hexdigest()}"
    assert manifest.get("sources") == VERSION_SOURCES


def test_community_data_version_allows_optional_inputs_to_be_absent(
    tmp_path: Path,
) -> None:
    (tmp_path / "photos.geojson").write_text(
        '{"type":"FeatureCollection","features":[]}',
        encoding="utf-8",
    )
    script = DATA_DIR.parents[2] / "scripts" / "update-community-data-version.mjs"
    subprocess.run(
        ["node", str(script)],
        check=True,
        env={**os.environ, "COMMUNITY_DATA_DIR": str(tmp_path)},
    )
    manifest = json.loads(
        (tmp_path / "community-data-version.json").read_text(encoding="utf-8")
    )
    assert str(manifest.get("version") or "").startswith("sha256:")
    assert manifest.get("sources") == VERSION_SOURCES
