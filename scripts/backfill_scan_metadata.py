#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill scan metadata from raw_records into geolocation/ok files",
    )
    parser.add_argument(
        "--raw-dir",
        default="output/raw_records",
        help="Directory with raw scraped records",
    )
    parser.add_argument(
        "--geo-dir",
        default="output/geolocation/ok",
        help="Directory with geolocated records",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing files",
    )
    parser.add_argument(
        "--sync-all",
        action="store_true",
        help="Overwrite scan metadata in geolocation files to match raw records",
    )
    return parser.parse_args()


def parse_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def as_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item or "").strip() for item in value]


def has_nonempty(values: list[str]) -> bool:
    return any(values)


def main() -> None:
    args = parse_args()
    raw_dir = Path(args.raw_dir)
    geo_dir = Path(args.geo_dir)

    if not raw_dir.exists():
        raise SystemExit(f"Raw directory not found: {raw_dir}")
    if not geo_dir.exists():
        raise SystemExit(f"Geolocation directory not found: {geo_dir}")

    raw_cache: dict[str, dict[str, object]] = {}
    for raw_file in raw_dir.glob("*.json"):
        try:
            payload = json.loads(raw_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        xid = str(payload.get("xid") or raw_file.stem).strip()
        if not xid:
            continue
        raw_cache[xid] = payload

    total = 0
    changed = 0
    changed_scan_count = 0
    changed_previews = 0
    changed_zoomify = 0
    missing_raw = 0

    for geo_file in geo_dir.glob("*.json"):
        total += 1
        try:
            geo = json.loads(geo_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(geo, dict):
            continue

        xid = str(geo.get("xid") or geo_file.stem).strip()
        raw = raw_cache.get(xid)
        if not raw:
            missing_raw += 1
            continue

        geo_scan_count = parse_int(geo.get("scan_count"), default=0)
        raw_scan_count = parse_int(raw.get("scan_count"), default=0)

        geo_previews = as_list(geo.get("scan_previews"))
        raw_previews = as_list(raw.get("scan_previews"))

        geo_zoomify = as_list(geo.get("scan_zoomify_paths"))
        raw_zoomify = as_list(raw.get("scan_zoomify_paths"))

        touched = False
        if args.sync_all:
            if geo_scan_count != raw_scan_count:
                geo["scan_count"] = raw_scan_count
                changed_scan_count += 1
                touched = True
            if geo_previews != raw_previews:
                geo["scan_previews"] = raw_previews
                changed_previews += 1
                touched = True
            if geo_zoomify != raw_zoomify:
                geo["scan_zoomify_paths"] = raw_zoomify
                changed_zoomify += 1
                touched = True
        else:
            if geo_scan_count <= 0 and raw_scan_count > 0:
                geo["scan_count"] = raw_scan_count
                changed_scan_count += 1
                touched = True

            if not has_nonempty(geo_previews) and has_nonempty(raw_previews):
                geo["scan_previews"] = raw_previews
                changed_previews += 1
                touched = True

            if not has_nonempty(geo_zoomify) and has_nonempty(raw_zoomify):
                geo["scan_zoomify_paths"] = raw_zoomify
                changed_zoomify += 1
                touched = True

        if touched:
            changed += 1
            if not args.dry_run:
                geo_file.write_text(
                    json.dumps(geo, ensure_ascii=False),
                    encoding="utf-8",
                )

    mode = "dry-run" if args.dry_run else "write"
    print(
        f"Backfill ({mode}) total={total} changed_files={changed} "
        f"scan_count={changed_scan_count} previews={changed_previews} "
        f"zoomify={changed_zoomify} missing_raw={missing_raw}"
    )


if __name__ == "__main__":
    main()
