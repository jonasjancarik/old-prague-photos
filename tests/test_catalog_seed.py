import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build_catalog_seed.py"
MIGRATION_PATHS = (
    ROOT / "migrations" / "0014_catalog_photos.sql",
    ROOT / "migrations" / "0015_catalog_digest.sql",
)
SPEC = importlib.util.spec_from_file_location("build_catalog_seed", SCRIPT_PATH)
assert SPEC and SPEC.loader
catalog_seed = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = catalog_seed
SPEC.loader.exec_module(catalog_seed)


def feature(
    xid: str,
    *,
    group_id: str = "series-a",
    description: str = "Pohled na Prahu",
    lon: float = 14.42,
    lat: float = 50.08,
) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "id": xid,
            "group_id": group_id,
            "kind": "pozitiv",
            "description": description,
            "date_label": "kol. 1912",
            "start_date": "1912-01-01",
            "end_date": "1912-12-31",
            "author": "O'Brien",
            "signature": "V 9/6 b",
            "note": "Poznámka",
            "views": "56x",
            "geolocation_type": "regional.address",
            "date_precision": "year_approx",
            "date_imprecise": False,
            "scan_count": 2,
            "scan_previews": ["https://example.test/preview-1.jpg"],
            "scan_zoomify_paths": ["https://example.test/zoomify-1"],
            "unneeded": "must not be stored in compact JSON",
        },
    }


def write_inputs(root: Path, *, version: str = "sha256:test-version") -> tuple[Path, Path, Path]:
    root.mkdir(parents=True, exist_ok=True)
    photos = root / "photos.geojson"
    orphans = root / "orphan_xids.json"
    metadata = root / "community-data-version.json"
    photos.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    feature("X3", group_id="series-c"),
                    feature("X1", description="Náměstí O'Brien"),
                    feature("X2", group_id="series-b"),
                ],
            }
        ),
        encoding="utf-8",
    )
    orphans.write_text(json.dumps(["X2", "NOT-IN-GEOJSON"]), encoding="utf-8")
    metadata.write_text(json.dumps({"version": version}), encoding="utf-8")
    return photos, orphans, metadata


def run_seed(tmp_path: Path, output_name: str = "seed") -> tuple[dict, Path]:
    photos, orphans, metadata = write_inputs(tmp_path)
    output_dir = tmp_path / output_name
    manifest = catalog_seed.build_seed(
        photos_path=photos,
        orphans_path=orphans,
        metadata_path=metadata,
        output_dir=output_dir,
        chunk_size=1,
    )
    return manifest, output_dir


def migrated_database() -> sqlite3.Connection:
    database = sqlite3.connect(":memory:")
    for migration_path in MIGRATION_PATHS:
        database.executescript(migration_path.read_text(encoding="utf-8"))
    return database


def test_seed_excludes_orphans_and_loads_metadata_after_migrations_14_and_15(tmp_path: Path) -> None:
    manifest, output_dir = run_seed(tmp_path)

    assert manifest["data_version"] == "sha256:test-version"
    assert manifest["catalog_digest"].startswith("sha256:")
    assert manifest["row_count"] == 2
    assert manifest["excluded_orphan_count"] == 1
    assert [item["name"] for item in manifest["files"]] == [
        "catalog_photos_0001.sql",
        "catalog_photos_0002.sql",
        "catalog_metadata.sql",
    ]
    assert all(item["rows"] <= 1 for item in manifest["files"][:-1])

    database = migrated_database()
    for item in manifest["files"]:
        database.executescript((output_dir / item["name"]).read_text(encoding="utf-8"))

    assert database.execute("SELECT xid FROM catalog_photos ORDER BY xid").fetchall() == [
        ("X1",),
        ("X3",),
    ]
    assert database.execute(
        "SELECT singleton, data_version, catalog_digest, row_count FROM catalog_metadata"
    ).fetchall() == [(1, "sha256:test-version", manifest["catalog_digest"], 2)]
    stored = database.execute(
        "SELECT base_group_id, source_lon, source_lat, feature_json, search_text "
        "FROM catalog_photos WHERE xid = 'X1'"
    ).fetchone()
    assert stored[:3] == ("series-a", 14.42, 50.08)
    compact = json.loads(stored[3])
    assert compact["scan_previews"] == ["https://example.test/preview-1.jpg"]
    assert compact["scan_zoomify_paths"] == ["https://example.test/zoomify-1"]
    assert "unneeded" not in compact
    assert "o'brien" in stored[4]

    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        database.execute(
            "UPDATE catalog_photos SET base_group_id = 'other' WHERE xid = 'X1'"
        )


def test_seed_replay_is_a_noop_and_changed_evidence_updates(tmp_path: Path) -> None:
    manifest, output_dir = run_seed(tmp_path)
    database = migrated_database()
    for item in manifest["files"]:
        database.executescript((output_dir / item["name"]).read_text(encoding="utf-8"))
    initial_changes = database.total_changes

    for item in manifest["files"]:
        database.executescript((output_dir / item["name"]).read_text(encoding="utf-8"))
    assert database.total_changes == initial_changes

    photos_path = tmp_path / "photos.geojson"
    photos = json.loads(photos_path.read_text(encoding="utf-8"))
    photos["features"][1]["properties"]["description"] = "Změněný pohled"
    photos_path.write_text(json.dumps(photos), encoding="utf-8")
    changed_dir = tmp_path / "changed-evidence"
    changed_manifest = catalog_seed.build_seed(
        photos_path=photos_path,
        orphans_path=tmp_path / "orphan_xids.json",
        metadata_path=tmp_path / "community-data-version.json",
        output_dir=changed_dir,
        chunk_size=1,
    )
    assert changed_manifest["catalog_digest"] != manifest["catalog_digest"]
    for item in changed_manifest["files"]:
        database.executescript((changed_dir / item["name"]).read_text(encoding="utf-8"))
    changed_feature = json.loads(
        database.execute(
            "SELECT feature_json FROM catalog_photos WHERE xid = 'X1'"
        ).fetchone()[0]
    )
    assert changed_feature["description"] == "Změněný pohled"
    assert database.execute(
        "SELECT source_lon, source_lat FROM catalog_photos WHERE xid = 'X1'"
    ).fetchone() == (14.42, 50.08)

    photos["features"][1]["properties"]["group_id"] = "new-base-group"
    photos_path.write_text(json.dumps(photos), encoding="utf-8")
    mismatch_dir = tmp_path / "mismatched-group"
    catalog_seed.build_seed(
        photos_path=photos_path,
        orphans_path=tmp_path / "orphan_xids.json",
        metadata_path=tmp_path / "community-data-version.json",
        output_dir=mismatch_dir,
        chunk_size=1,
    )
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        database.executescript(
            (mismatch_dir / "catalog_photos_0001.sql").read_text(encoding="utf-8")
        )


def test_catalog_digest_is_independent_of_chunk_size(tmp_path: Path) -> None:
    photos, orphans, metadata = write_inputs(tmp_path)
    first = catalog_seed.build_seed(
        photos_path=photos,
        orphans_path=orphans,
        metadata_path=metadata,
        output_dir=tmp_path / "one-per-chunk",
        chunk_size=1,
    )
    second = catalog_seed.build_seed(
        photos_path=photos,
        orphans_path=orphans,
        metadata_path=metadata,
        output_dir=tmp_path / "all-in-one",
        chunk_size=2,
    )

    assert first["catalog_digest"] == second["catalog_digest"]
    assert first["row_count"] == second["row_count"]


def test_metadata_is_not_marked_current_when_existing_catalog_has_extra_row(tmp_path: Path) -> None:
    manifest, output_dir = run_seed(tmp_path)
    database = migrated_database()
    database.execute(
        "INSERT INTO catalog_photos "
        "(xid, base_group_id, source_lon, source_lat, feature_json, search_text) "
        "VALUES ('STALE', 'stale', 14.4, 50.1, '{}', 'stale')"
    )
    database.execute(
        "INSERT INTO catalog_metadata (singleton, data_version, catalog_digest, row_count) "
        "VALUES (1, 'old-version', 'sha256:old', 3)"
    )

    for item in manifest["files"]:
        database.executescript((output_dir / item["name"]).read_text(encoding="utf-8"))

    assert database.execute(
        "SELECT data_version, catalog_digest, row_count FROM catalog_metadata"
    ).fetchall() == [("old-version", "sha256:old", 3)]


def test_seed_uses_escaped_literals_and_is_deterministic(tmp_path: Path) -> None:
    first_manifest, first_dir = run_seed(tmp_path / "first")
    second_manifest, second_dir = run_seed(tmp_path / "second")

    assert first_manifest == second_manifest
    assert sorted(path.name for path in first_dir.iterdir()) == sorted(
        path.name for path in second_dir.iterdir()
    )
    for first_path in sorted(first_dir.iterdir()):
        assert first_path.read_bytes() == (second_dir / first_path.name).read_bytes()
    sql = (first_dir / "catalog_photos_0001.sql").read_text(encoding="utf-8")
    assert "BEGIN;" not in sql
    assert "COMMIT;" not in sql
    assert "O''Brien" in sql


def test_dry_run_writes_no_files_and_missing_version_fails(tmp_path: Path) -> None:
    photos, orphans, metadata = write_inputs(tmp_path)
    output_dir = tmp_path / "dry-run"
    manifest = catalog_seed.build_seed(
        photos_path=photos,
        orphans_path=orphans,
        metadata_path=metadata,
        output_dir=output_dir,
        chunk_size=2,
        dry_run=True,
    )
    assert manifest["row_count"] == 2
    assert not output_dir.exists()

    metadata.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="catalog data version"):
        catalog_seed.build_seed(
            photos_path=photos,
            orphans_path=orphans,
            metadata_path=metadata,
            output_dir=output_dir,
        )


def test_seed_rejects_a_statement_above_d1_limit_before_writing(tmp_path: Path) -> None:
    photos, orphans, metadata = write_inputs(tmp_path)
    payload = json.loads(photos.read_text(encoding="utf-8"))
    payload["features"][0]["properties"]["description"] = "x" * 100_000
    photos.write_text(json.dumps(payload), encoding="utf-8")
    output_dir = tmp_path / "too-long"

    with pytest.raises(ValueError, match="100,000-byte statement limit"):
        catalog_seed.build_seed(
            photos_path=photos,
            orphans_path=orphans,
            metadata_path=metadata,
            output_dir=output_dir,
            chunk_size=1,
        )
    assert not output_dir.exists()

def test_chunk_size_is_bounded(tmp_path: Path) -> None:
    photos, orphans, metadata = write_inputs(tmp_path)
    with pytest.raises(ValueError, match="between 1 and"):
        catalog_seed.build_seed(
            photos_path=photos,
            orphans_path=orphans,
            metadata_path=metadata,
            output_dir=tmp_path / "seed",
            chunk_size=catalog_seed.MAX_CHUNK_SIZE + 1,
        )
