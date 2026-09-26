#!/usr/bin/env python3
"""Enrich only published features; never rebuild geometry or media caches."""
import argparse
import copy
import json
from pathlib import Path

from src.pipeline.atomic_io import atomic_write_json
from src.pipeline.place_normalization import normalize_archive_metadata


def enrich(photos_path, raw_dir, output_path):
    original = json.loads(photos_path.read_text())
    candidate = copy.deepcopy(original)
    report = {"features": len(candidate["features"]), "raw_source_gaps": 0,
              "known_places": 0, "unknown_places": 0, "ambiguous_places": 0,
              "authors_known": 0, "xids_added": 0, "xids_removed": 0,
              "group_ids_changed": 0, "geometry_changed": 0}
    letenska_xids, letenska_groups = set(), set()
    archive_letenska_xids, archive_letenska_groups = set(), set()
    for feature in candidate["features"]:
        props = feature["properties"]
        path = raw_dir / (props["id"] + ".json")
        raw = json.loads(path.read_text()) if path.exists() else None
        if raw is not None and raw.get("xid") != props["id"]:
            raise ValueError(f"Raw XID mismatch: {path}")
        report["raw_source_gaps"] += raw is None
        props.update(normalize_archive_metadata(raw))
        report["known_places"] += bool(props["places"])
        report["unknown_places"] += not props["places"]
        report["ambiguous_places"] += any(p["ambiguous"] for p in props["places"])
        report["authors_known"] += bool(props["authors"])
        if "Malá Strana" in props["archive_place_terms"] and any(t in props["archive_place_terms"] for t in ("Letenská", "Letenská ulice")):
            archive_letenska_xids.add(props["id"])
            archive_letenska_groups.add(props["group_id"])
        if any(p["label"] == "Letenská" and p.get("district") == "Malá Strana" for p in props["places"]):
            letenska_xids.add(props["id"])
            letenska_groups.add(props["group_id"])
    # Only the three new fields may change. This validates all source fields,
    # including XIDs, geometry, immutable series IDs and media assignments.
    restored = copy.deepcopy(candidate)
    for old, new in zip(original["features"], restored["features"], strict=True):
        for field in ("archive_place_terms", "places", "authors"):
            if field in old["properties"]:
                new["properties"][field] = old["properties"][field]
            else:
                new["properties"].pop(field, None)
    if restored != original:
        raise ValueError("Candidate changes existing published source fields")
    atomic_write_json(output_path, candidate)
    report.update(letenska_xids=len(letenska_xids), letenska_groups=len(letenska_groups),
                  archive_letenska_xids=len(archive_letenska_xids),
                  archive_letenska_groups=len(archive_letenska_groups),
                  bytes=output_path.stat().st_size, photos_source=str(photos_path.resolve()),
                  raw_source=str(raw_dir.resolve()))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--photos', type=Path, default=Path('viewer/static/data/photos.geojson'))
    parser.add_argument('--raw-dir', type=Path, default=Path('output/raw_records'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(enrich(args.photos, args.raw_dir, args.output), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
