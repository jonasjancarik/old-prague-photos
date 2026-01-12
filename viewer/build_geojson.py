import argparse
import csv
import json
import hashlib
from pathlib import Path

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


def build_group_id(row: dict[str, str]) -> str:
    parts = [
        normalize_group_value(row.get("obsah")),
        normalize_group_value(row.get("autor")),
        normalize_group_value(row.get("datace")),
    ]
    key = "\x1f".join(parts)
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


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


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)

    features = []
    with input_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            lat = to_float(row.get("geolocation_position_lat"))
            lon = to_float(row.get("geolocation_position_lon"))
            if lat is None or lon is None:
                continue

            scan_previews = parse_json_array(row.get("scan_previews"))
            scan_zoomify_paths = parse_json_array(row.get("scan_zoomify_paths"))
            scan_count = parse_int(row.get("scan_count"))
            if scan_count <= 0:
                scan_count = max(len(scan_previews), len(scan_zoomify_paths))

            group_id = row.get("group_id", "").strip() or build_group_id(row)

            properties = {
                "id": row.get("xid", "").strip(),
                "group_id": group_id,
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
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(geojson, handle, ensure_ascii=False)

    print(f"Wrote {len(features)} features to {output_path}")


if __name__ == "__main__":
    main()
