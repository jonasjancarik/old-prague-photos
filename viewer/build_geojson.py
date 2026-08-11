import argparse
import csv
import json
import hashlib
from pathlib import Path

from src.pipeline.atomic_io import atomic_write_json

DATE_PLACEHOLDER_START = "1800-01-01"
DATE_PLACEHOLDER_END = "2000-12-31"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build GeoJSON from old_prague_photos.csv")
    parser.add_argument(
        "--input",
        default="output/old_prague_photos.csv",
        help="Path to CSV export",
    )
    parser.add_argument(
        "--output",
        default="viewer/static/data/photos.geojson",
        help="Path to write GeoJSON",
    )
    parser.add_argument(
        "--existing-groups",
        default="viewer/static/data/photos.geojson",
        help="Published GeoJSON whose XID-to-series assignments must be preserved",
    )
    return parser.parse_args()


def to_float(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_group_value(value: str | None) -> str:
    if value is None:
        return ""
    return str(value).strip()


def build_group_key(row: dict[str, str]) -> str:
    parts = [
        normalize_group_value(row.get("obsah")),
        normalize_group_value(row.get("autor")),
        normalize_group_value(row.get("datace")),
    ]
    return "\x1f".join(parts)


def build_group_id(row: dict[str, str]) -> str:
    """Create an immutable initial ID; later builds preserve it by XID."""
    xid = normalize_group_value(row.get("xid"))
    seed = xid or build_group_key(row)
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"series_{digest}"


def load_existing_group_ids(output_path: Path) -> dict[str, str]:
    if not output_path.exists():
        return {}
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    mapping: dict[str, str] = {}
    for feature in payload.get("features", []):
        props = feature.get("properties") or {}
        xid = normalize_group_value(props.get("id"))
        group_id = normalize_group_value(props.get("group_id"))
        if xid and group_id:
            mapping[xid] = group_id
    return mapping


def parse_json_array(value: str | None) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    text = str(value).strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def parse_int(value: str | None) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if not normalized:
        return None
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    return None


def compute_date_imprecise(
    start_date: str | None,
    end_date: str | None,
) -> bool:
    start = str(start_date or "").strip()
    end = str(end_date or "").strip()

    # Open-ended placeholder bounds represent uncertain lower/upper limits.
    return start == DATE_PLACEHOLDER_START or end == DATE_PLACEHOLDER_END


def build_geojson(
    input_path: Path,
    output_path: Path,
    *,
    existing_groups_path: Path | None = None,
) -> int:
    features = []
    existing_group_by_xid: dict[str, str] = {}
    if existing_groups_path is not None:
        existing_group_by_xid.update(load_existing_group_ids(existing_groups_path))
    # An already-derived destination is newer than the published baseline.
    existing_group_by_xid.update(load_existing_group_ids(output_path))
    rows: list[dict[str, str]] = []
    with input_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    group_ids_by_metadata: dict[str, set[str]] = {}
    for row in rows:
        xid = normalize_group_value(row.get("xid"))
        explicit_group_id = normalize_group_value(row.get("group_id"))
        preserved_group_id = existing_group_by_xid.get(xid, "")
        group_id = preserved_group_id or explicit_group_id
        if group_id:
            group_ids_by_metadata.setdefault(build_group_key(row), set()).add(group_id)

    for row in rows:
        lat = to_float(row.get("geolocation_position_lat"))
        lon = to_float(row.get("geolocation_position_lon"))
        if lat is None or lon is None:
            continue

        scan_previews = parse_json_array(row.get("scan_previews"))
        scan_zoomify_paths = parse_json_array(row.get("scan_zoomify_paths"))
        scan_count = parse_int(row.get("scan_count"))
        if scan_count <= 0:
            scan_count = max(len(scan_previews), len(scan_zoomify_paths))

        xid = normalize_group_value(row.get("xid"))
        group_key = build_group_key(row)
        group_id = (
            existing_group_by_xid.get(xid, "")
            or normalize_group_value(row.get("group_id"))
            or min(group_ids_by_metadata.get(group_key, set()), default="")
            or build_group_id(row)
        )
        group_ids_by_metadata.setdefault(group_key, set()).add(group_id)
        csv_imprecise = parse_bool(row.get("date_imprecise"))
        date_imprecise = (
            csv_imprecise
            if csv_imprecise is not None
            else compute_date_imprecise(
                row.get("start_date"),
                row.get("end_date"),
            )
        )

        properties = {
            "id": row.get("xid", "").strip(),
            "group_id": group_id,
            "group_revision": 1,
            "kind": row.get("druh", "").strip(),
            "description": row.get("obsah", "").strip(),
            "date_label": row.get("datace", "").strip(),
            "start_date": row.get("start_date", "").strip(),
            "end_date": row.get("end_date", "").strip(),
            "author": row.get("autor", "").strip(),
            "signature": row.get("signatura", "").strip(),
            "note": row.get("poznámka", "").strip(),
            "views": row.get("zobrazeno", "").strip(),
            "geolocation_type": row.get("geolocation_type", "").strip(),
            "date_precision": row.get("date_precision", "").strip(),
            "date_imprecise": date_imprecise,
            "scan_count": scan_count,
            "scan_previews": scan_previews,
            "scan_zoomify_paths": scan_zoomify_paths,
        }

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": properties,
            }
        )

    geojson = {"type": "FeatureCollection", "features": features}
    atomic_write_json(output_path, geojson)

    print(f"Wrote {len(features)} features to {output_path}")
    return len(features)


def main() -> None:
    args = parse_args()
    build_geojson(
        input_path=Path(args.input),
        output_path=Path(args.output),
        existing_groups_path=Path(args.existing_groups),
    )


if __name__ == "__main__":
    main()
