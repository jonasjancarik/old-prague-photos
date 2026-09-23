#!/usr/bin/env python3
"""Build deterministic, local SQL seed files for the D1 photo catalogue.

The seed contains one source record per visible GeoJSON feature.  It deliberately
does not expand a record into scans or tiles: previews and Zoomify paths stay in
the compact JSON payload, keeping the initial D1 write count near 12.5k rows.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


FEATURE_FIELDS = (
    "kind",
    "description",
    "date_label",
    "start_date",
    "end_date",
    "author",
    "signature",
    "note",
    "views",
    "geolocation_type",
    "date_precision",
    "date_imprecise",
    "scan_count",
    "scan_previews",
    "scan_zoomify_paths",
)
SEARCH_FIELDS = ("id", "description", "author", "date_label", "signature", "note", "kind")
DEFAULT_CHUNK_SIZE = 64
MAX_CHUNK_SIZE = 250
# D1 rejects a SQL statement longer than 100,000 bytes. Keep room for future
# photo metadata growth and fail locally before attempting a remote import.
MAX_SQL_CHUNK_BYTES = 90_000


@dataclass(frozen=True)
class CatalogPhoto:
    xid: str
    base_group_id: str
    source_lon: float
    source_lat: float
    feature_json: str
    search_text: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate local, deterministic SQL chunks for catalog_photos."
    )
    parser.add_argument("--photos", type=Path, default=Path("viewer/static/data/photos.geojson"))
    parser.add_argument("--orphans", type=Path, default=Path("viewer/static/data/orphan_xids.json"))
    parser.add_argument(
        "--metadata",
        type=Path,
        default=Path("viewer/static/data/community-data-version.json"),
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the deterministic manifest without writing SQL or manifest files.",
    )
    return parser.parse_args()


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"Missing required input: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc


def required_text(value: Any, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"Missing {field}")
    if "\x00" in text:
        raise ValueError(f"{field} contains a NUL character")
    return text


def finite_coordinate(value: Any, field: str, lower: float, upper: float) -> float:
    if isinstance(value, bool):
        raise ValueError(f"Invalid {field}: {value!r}")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid {field}: {value!r}") from exc
    if not math.isfinite(number) or not lower <= number <= upper:
        raise ValueError(f"Invalid {field}: {value!r}")
    return number


def compact_feature(properties: dict[str, Any]) -> dict[str, Any]:
    """Keep evidence and media fields that the public detail view needs."""
    compact: dict[str, Any] = {}
    for field in FEATURE_FIELDS:
        value = properties.get(field)
        if field in {"scan_previews", "scan_zoomify_paths"}:
            compact[field] = value if isinstance(value, list) else []
        elif field == "scan_count":
            try:
                compact[field] = max(0, int(value or 0))
            except (TypeError, ValueError):
                compact[field] = 0
        elif field == "date_imprecise":
            compact[field] = bool(value)
        else:
            compact[field] = str(value or "").strip()
    return compact


def normalize_search_text(properties: dict[str, Any]) -> str:
    values = [str(properties.get(field) or "") for field in SEARCH_FIELDS]
    return " ".join(" ".join(values).split()).casefold()


def load_orphan_xids(path: Path) -> set[str]:
    payload = load_json(path)
    if not isinstance(payload, list):
        raise ValueError(f"Expected a JSON array of orphan XIDs in {path}")
    return {required_text(value, "orphan XID") for value in payload}


def load_catalog_photos(photos_path: Path, orphan_xids: set[str]) -> list[CatalogPhoto]:
    payload = load_json(photos_path)
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        raise ValueError(f"Expected a GeoJSON FeatureCollection in {photos_path}")

    records: list[CatalogPhoto] = []
    seen_xids: set[str] = set()
    for position, feature in enumerate(features):
        if not isinstance(feature, dict):
            raise ValueError(f"Feature {position} is not an object")
        properties = feature.get("properties")
        geometry = feature.get("geometry")
        if not isinstance(properties, dict) or not isinstance(geometry, dict):
            raise ValueError(f"Feature {position} is missing properties or geometry")
        xid = required_text(properties.get("id"), f"feature {position} XID")
        if xid in seen_xids:
            raise ValueError(f"Duplicate XID in GeoJSON: {xid}")
        seen_xids.add(xid)
        if xid in orphan_xids:
            continue
        coordinates = geometry.get("coordinates")
        if geometry.get("type") != "Point" or not isinstance(coordinates, list) or len(coordinates) != 2:
            raise ValueError(f"Feature {xid} does not have Point coordinates")
        lon = finite_coordinate(coordinates[0], f"feature {xid} longitude", -180, 180)
        lat = finite_coordinate(coordinates[1], f"feature {xid} latitude", -90, 90)
        compact = compact_feature(properties)
        records.append(
            CatalogPhoto(
                xid=xid,
                base_group_id=required_text(properties.get("group_id"), f"feature {xid} group_id"),
                source_lon=lon,
                source_lat=lat,
                feature_json=json.dumps(
                    compact,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ),
                search_text=normalize_search_text(properties),
            )
        )
    return sorted(records, key=lambda record: record.xid)


def load_data_version(metadata_path: Path) -> str:
    payload = load_json(metadata_path)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object in {metadata_path}")
    return required_text(payload.get("version"), "catalog data version")


def sql_literal(value: str) -> str:
    if "\x00" in value:
        raise ValueError("SQL literals cannot contain NUL characters")
    return "'" + value.replace("'", "''") + "'"


def format_number(value: float) -> str:
    if not math.isfinite(value):
        raise ValueError(f"SQL numeric literal must be finite: {value!r}")
    return format(value, ".17g")


def sql_row(record: CatalogPhoto) -> str:
    values = (
        sql_literal(record.xid),
        sql_literal(record.base_group_id),
        format_number(record.source_lon),
        format_number(record.source_lat),
        sql_literal(record.feature_json),
        sql_literal(record.search_text),
    )
    return "(" + ", ".join(values) + ")"


def chunks(records: Sequence[CatalogPhoto], chunk_size: int) -> Iterable[Sequence[CatalogPhoto]]:
    if not 1 <= chunk_size <= MAX_CHUNK_SIZE:
        raise ValueError(f"chunk size must be between 1 and {MAX_CHUNK_SIZE}")
    for start in range(0, len(records), chunk_size):
        yield records[start : start + chunk_size]


def render_chunk(records: Sequence[CatalogPhoto]) -> str:
    if not records:
        raise ValueError("Cannot render an empty SQL chunk")
    # One INSERT statement is atomic. D1's wrangler execute wraps files in a
    # transaction, so explicit BEGIN/COMMIT would fail on remote imports.
    return "\n".join(
        (
            "INSERT INTO catalog_photos (xid, base_group_id, source_lon, source_lat, feature_json, search_text)",
            "VALUES",
            ",\n".join(sql_row(record) for record in records),
            "ON CONFLICT(xid) DO UPDATE SET",
            "  base_group_id = excluded.base_group_id,",
            "  source_lon = excluded.source_lon,",
            "  source_lat = excluded.source_lat,",
            "  feature_json = excluded.feature_json,",
            "  search_text = excluded.search_text",
            "WHERE catalog_photos.base_group_id IS NOT excluded.base_group_id",
            "   OR catalog_photos.source_lon IS NOT excluded.source_lon",
            "   OR catalog_photos.source_lat IS NOT excluded.source_lat",
            "   OR catalog_photos.feature_json IS NOT excluded.feature_json",
            "   OR catalog_photos.search_text IS NOT excluded.search_text;",
            "",
        )
    )


def digest_catalog_records(records: Sequence[CatalogPhoto]) -> str:
    """Return a stable digest of the exact source fields stored in D1."""
    normalized = [
        {
            "base_group_id": record.base_group_id,
            "feature_json": record.feature_json,
            "search_text": record.search_text,
            "source_lat": format_number(record.source_lat),
            "source_lon": format_number(record.source_lon),
            "xid": record.xid,
        }
        for record in records
    ]
    payload = json.dumps(
        normalized,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def render_metadata(data_version: str, catalog_digest: str, row_count: int) -> str:
    """Only mark the seed current after every expected source row is present."""
    return "\n".join(
        (
            "INSERT INTO catalog_metadata (singleton, data_version, catalog_digest, row_count)",
            "SELECT 1, "
            f"{sql_literal(data_version)}, {sql_literal(catalog_digest)}, {row_count}",
            "WHERE (SELECT COUNT(*) FROM catalog_photos) = " + str(row_count),
            "ON CONFLICT(singleton) DO UPDATE SET",
            "  data_version = excluded.data_version,",
            "  catalog_digest = excluded.catalog_digest,",
            "  row_count = excluded.row_count",
            "WHERE (SELECT COUNT(*) FROM catalog_photos) = excluded.row_count",
            "  AND (catalog_metadata.data_version IS NOT excluded.data_version",
            "       OR catalog_metadata.catalog_digest IS NOT excluded.catalog_digest",
            "       OR catalog_metadata.row_count IS NOT excluded.row_count);",
            "",
        )
    )


def file_digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_manifest(
    *,
    data_version: str,
    catalog_digest: str,
    records: Sequence[CatalogPhoto],
    chunk_size: int,
    sql_files: Sequence[tuple[str, str, int]],
) -> dict[str, Any]:
    return {
        "data_version": data_version,
        "catalog_digest": catalog_digest,
        "row_count": len(records),
        "excluded_orphan_count": 0,
        "chunk_size": chunk_size,
        "files": [
            {"name": name, "sha256": file_digest(content), "rows": row_count}
            for name, content, row_count in sql_files
        ],
    }


def build_seed(
    *,
    photos_path: Path,
    orphans_path: Path,
    metadata_path: Path,
    output_dir: Path,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    dry_run: bool = False,
) -> dict[str, Any]:
    orphan_xids = load_orphan_xids(orphans_path)
    records = load_catalog_photos(photos_path, orphan_xids)
    data_version = load_data_version(metadata_path)
    catalog_digest = digest_catalog_records(records)
    sql_files: list[tuple[str, str, int]] = []
    for number, record_chunk in enumerate(chunks(records, chunk_size), start=1):
        content = render_chunk(record_chunk)
        size = len(content.encode("utf-8"))
        if size >= MAX_SQL_CHUNK_BYTES:
            raise ValueError(
                f"Catalog SQL chunk {number} is {size} bytes; lower --chunk-size "
                f"to stay below D1's 100,000-byte statement limit"
            )
        sql_files.append((f"catalog_photos_{number:04d}.sql", content, len(record_chunk)))
    metadata_name = "catalog_metadata.sql"
    metadata_content = render_metadata(data_version, catalog_digest, len(records))
    if len(metadata_content.encode("utf-8")) >= MAX_SQL_CHUNK_BYTES:
        raise ValueError("Catalog metadata SQL exceeds D1's 100,000-byte statement limit")
    sql_files.append((metadata_name, metadata_content, 1))
    manifest = build_manifest(
        data_version=data_version,
        catalog_digest=catalog_digest,
        records=records,
        chunk_size=chunk_size,
        sql_files=sql_files,
    )
    # The input may list already-absent orphans. Report all source exclusions
    # by comparing the original feature XIDs before filtering.
    source_xids = {
        required_text((feature.get("properties") or {}).get("id"), "feature XID")
        for feature in (load_json(photos_path).get("features") or [])
        if isinstance(feature, dict)
    }
    manifest["excluded_orphan_count"] = len(orphan_xids & source_xids)

    if not dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)
        for name, content, _ in sql_files:
            (output_dir / name).write_text(content, encoding="utf-8", newline="\n")
        (output_dir / "catalog-seed-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    return manifest


def main() -> None:
    args = parse_args()
    manifest = build_seed(
        photos_path=args.photos,
        orphans_path=args.orphans,
        metadata_path=args.metadata,
        output_dir=args.output_dir,
        chunk_size=args.chunk_size,
        dry_run=args.dry_run,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
