import argparse
import json
import os
import time
from dataclasses import replace
from pathlib import Path

import requests

from src.utils.similarity_core import (
    HashCacheEntry,
    HashSourceError,
    PhotoHash,
    append_hash_record,
    build_candidates,
    build_series_clusters,
    load_features,
    load_hash_cache,
)
from src.utils.similarity_images import (
    build_zoomify_candidates,
    build_zoomify_tile_urls,
    compute_hash_for_scan,
    normalize_base_url,
    select_stitch_level,
)


DEFAULT_ARCHIVE_BASE_URL = "https://katalog.ahmp.cz/pragapublica"
DEFAULT_DOWNLOAD_ROOT = "downloads/archive"
HASH_ALGO = "dhash-edge-mountcrop"
HASH_PROFILE_VERSION = 4
DEFAULT_PAIR_DISTANCE = 18
DEFAULT_CLUSTER_DISTANCE = 32


def resolve_distances(
    distance_alias: int | None,
    pair_distance: int | None,
    cluster_distance: int | None,
) -> tuple[int, int]:
    pair = DEFAULT_PAIR_DISTANCE if pair_distance is None else pair_distance
    cluster = DEFAULT_CLUSTER_DISTANCE if cluster_distance is None else cluster_distance
    if distance_alias is not None:
        if pair_distance is None:
            pair = distance_alias
        if cluster_distance is None:
            cluster = distance_alias
    return pair, cluster


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build similarity candidates using perceptual hashes",
    )
    parser.add_argument(
        "--input",
        default="viewer/static/data/photos.geojson",
        help="GeoJSON input with photo metadata",
    )
    parser.add_argument(
        "--output",
        default="viewer/static/data/similarity_candidates.json",
        help="Output JSON with similarity candidates",
    )
    parser.add_argument(
        "--clusters-output",
        default="viewer/static/data/series_version_clusters.json",
        help="Output JSON with per-series version clusters",
    )
    parser.add_argument(
        "--hash-cache",
        default="output/similarity/hashes.jsonl",
        help="Cache for computed hashes",
    )
    parser.add_argument(
        "--distance",
        type=int,
        default=None,
        help="Backward-compatible alias for both --pair-distance and --cluster-distance",
    )
    parser.add_argument(
        "--pair-distance",
        type=int,
        default=None,
        help=(
            "Max Hamming distance for cross-series candidate pairs "
            f"(default: {DEFAULT_PAIR_DISTANCE})"
        ),
    )
    parser.add_argument(
        "--cluster-distance",
        type=int,
        default=None,
        help=(
            "Max Hamming distance for in-series version clustering "
            f"(default: {DEFAULT_CLUSTER_DISTANCE})"
        ),
    )
    parser.add_argument(
        "--hash-size",
        type=int,
        default=8,
        help="Hash grid size (8 => 128-bit composite hash)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Limit number of photos (0 = all)",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.0,
        help="Delay between network requests (seconds)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Recompute hashes even if cache exists",
    )
    parser.add_argument(
        "--archive-base-url",
        default=os.getenv("ARCHIVE_BASE_URL", DEFAULT_ARCHIVE_BASE_URL),
        help="Base URL for archive permalinks",
    )
    parser.add_argument(
        "--r2-tiles-base",
        default=os.getenv("R2_TILES_BASE", ""),
        help="Base URL of public R2 tiles (layout: /<xid>/scan_<n>/...)",
    )
    parser.add_argument(
        "--download-root",
        default=DEFAULT_DOWNLOAD_ROOT,
        help="Root directory for downloaded previews/tiles",
    )
    parser.add_argument(
        "--no-download-cache",
        action="store_true",
        help="Disable local download cache usage",
    )
    parser.add_argument(
        "--stitch-target-long-side",
        type=int,
        default=1024,
        help="Preferred stitched image long side in pixels",
    )
    parser.add_argument(
        "--stitch-max-tiles",
        type=int,
        default=16,
        help="Max number of tiles for stitched render level",
    )

    args = parser.parse_args()
    args.archive_base_url = normalize_base_url(args.archive_base_url)
    args.r2_tiles_base = normalize_base_url(args.r2_tiles_base)
    pair_distance, cluster_distance = resolve_distances(
        args.distance,
        args.pair_distance,
        args.cluster_distance,
    )
    args.pair_distance = pair_distance
    args.cluster_distance = cluster_distance
    return args


def build_hash_profile(args: argparse.Namespace) -> str:
    r2_enabled = "1" if args.r2_tiles_base else "0"
    source_policy = "local_stitched>r2>feature_zoomify>archive_zoomify>preview"
    return (
        f"{HASH_ALGO}-v{HASH_PROFILE_VERSION}|hash_size={args.hash_size}|"
        f"source_policy={source_policy}|preprocess=mounted_photo_crop_v1|"
        f"r2_enabled={r2_enabled}|"
        f"stitch_target={args.stitch_target_long_side}|stitch_max_tiles={args.stitch_max_tiles}"
    )


def build_photo_hash_maps(
    entries: dict[tuple[str, int], HashCacheEntry],
    xids_in_features: set[str],
) -> tuple[dict[str, list[PhotoHash]], dict[str, list[PhotoHash]]]:
    hashes_by_xid: dict[str, list[PhotoHash]] = {}
    hashes_by_group: dict[str, list[PhotoHash]] = {}
    for entry in entries.values():
        if entry.xid not in xids_in_features:
            continue
        record = PhotoHash(
            xid=entry.xid,
            group_id=entry.group_id,
            hash_value=entry.hash_value,
            scan_index=entry.scan_index,
        )
        hashes_by_xid.setdefault(record.xid, []).append(record)
        hashes_by_group.setdefault(record.group_id, []).append(record)
    return hashes_by_xid, hashes_by_group


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    clusters_output_path = Path(args.clusters_output)
    hash_cache_path = Path(args.hash_cache)
    error_path = hash_cache_path.with_name("errors.jsonl")
    download_root = Path(args.download_root)
    stitched_root = hash_cache_path.parent / "stitched"
    hash_profile = build_hash_profile(args)

    features = load_features(input_path, args.limit)
    cache = load_hash_cache(
        hash_cache_path,
        args.force,
        args.hash_size,
        hash_profile,
        expected_algo=HASH_ALGO,
    )
    total_scans = sum(len(item["scans"]) for item in features)
    if total_scans:
        print(f"Processing {total_scans} scans across {len(features)} photos")
    processed = 0
    hashed = 0
    cached_count = 0
    error_count = 0
    report_every = max(1, total_scans // 50) if total_scans else 0

    session = requests.Session()
    session.headers.update({"User-Agent": "old-prague-photos/similarity"})

    records_by_key: dict[tuple[str, int], HashCacheEntry] = dict(cache)
    hash_cache_path.parent.mkdir(parents=True, exist_ok=True)
    stitched_root.mkdir(parents=True, exist_ok=True)
    error_path.parent.mkdir(parents=True, exist_ok=True)

    cache_mode = "w" if args.force else "a"
    error_mode = "w" if args.force else "a"

    with hash_cache_path.open(cache_mode, encoding="utf-8") as cache_handle, error_path.open(
        error_mode, encoding="utf-8"
    ) as error_handle:
        for item in features:
            xid = str(item["xid"])
            group_id = str(item["group_id"])
            scans = item["scans"]
            assert isinstance(scans, list)

            for scan in scans:
                scan_index = scan.scan_index
                key = (xid, scan_index)
                cached = records_by_key.get(key)
                if cached and not args.force:
                    if cached.group_id != group_id:
                        cached = replace(cached, group_id=group_id)
                        records_by_key[key] = cached
                    cached_count += 1
                    processed += 1
                    if report_every and processed % report_every == 0:
                        percent = (processed / total_scans) * 100
                        print(
                            f"Progress {processed}/{total_scans} ({percent:.1f}%) "
                            f"hashed {hashed} cached {cached_count} errors {error_count}"
                        )
                    continue

                try:
                    hash_result = compute_hash_for_scan(
                        session=session,
                        xid=xid,
                        scan=scan,
                        archive_base_url=args.archive_base_url,
                        r2_tiles_base=args.r2_tiles_base,
                        hash_size=args.hash_size,
                        stitch_target_long_side=args.stitch_target_long_side,
                        stitch_max_tiles=args.stitch_max_tiles,
                        download_root=download_root,
                        stitched_root=stitched_root,
                        no_download_cache=args.no_download_cache,
                    )
                except Exception as exc:
                    source_attempts = []
                    if isinstance(exc, HashSourceError):
                        source_attempts = exc.source_attempts
                    error_handle.write(
                        json.dumps(
                            {
                                "xid": xid,
                                "group_id": group_id,
                                "scan_index": scan_index,
                                "preview_url": scan.preview_url,
                                "feature_zoomify_path": scan.feature_zoomify_path,
                                "error": str(exc),
                                "source_attempts": source_attempts,
                            },
                            ensure_ascii=True,
                        )
                        + "\n"
                    )
                    print(f"Failed {xid} scan {scan_index}: {exc}")
                    error_count += 1
                    processed += 1
                    if report_every and processed % report_every == 0:
                        percent = (processed / total_scans) * 100
                        print(
                            f"Progress {processed}/{total_scans} ({percent:.1f}%) "
                            f"hashed {hashed} cached {cached_count} errors {error_count}"
                        )
                    continue

                entry = HashCacheEntry(
                    xid=xid,
                    group_id=group_id,
                    hash_value=hash_result.hash_value,
                    scan_index=scan_index,
                    hash_profile=hash_profile,
                    image_source=hash_result.image_source,
                    render_mode=hash_result.render_mode,
                    image_width=hash_result.image_width,
                    image_height=hash_result.image_height,
                )
                records_by_key[key] = entry
                append_hash_record(cache_handle, entry, args.hash_size, algo=HASH_ALGO)
                hashed += 1
                processed += 1
                if report_every and processed % report_every == 0:
                    percent = (processed / total_scans) * 100
                    print(
                        f"Progress {processed}/{total_scans} ({percent:.1f}%) "
                        f"hashed {hashed} cached {cached_count} errors {error_count}"
                    )
                if args.sleep:
                    time.sleep(args.sleep)

    xids_in_features = {str(item["xid"]) for item in features}
    hashes_by_xid, hashes_by_group = build_photo_hash_maps(records_by_key, xids_in_features)

    records: list[PhotoHash] = []
    for xid in xids_in_features:
        per_xid = hashes_by_xid.get(xid, [])
        if not per_xid:
            continue
        primary = next((item for item in per_xid if item.scan_index == 0), per_xid[0])
        records.append(primary)
    if total_scans:
        percent = (processed / total_scans) * 100
        print(
            f"Progress {processed}/{total_scans} ({percent:.1f}%) "
            f"hashed {hashed} cached {cached_count} errors {error_count}"
        )

    candidates = build_candidates(records, args.pair_distance)
    clusters = build_series_clusters(hashes_by_group, hashes_by_xid, args.cluster_distance)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "distance": args.pair_distance,
        "pair_distance": args.pair_distance,
        "hash_size": args.hash_size,
        "algo": HASH_ALGO,
        "pairs": sorted(
            candidates,
            key=lambda item: (item["distance"], item["group_id_a"], item["group_id_b"]),
        ),
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
    print(f"Wrote {len(candidates)} candidates to {output_path}")

    clusters_output_path.parent.mkdir(parents=True, exist_ok=True)
    cluster_payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "distance": args.cluster_distance,
        "cluster_distance": args.cluster_distance,
        "hash_size": args.hash_size,
        "algo": HASH_ALGO,
        "clusters": clusters,
    }
    clusters_output_path.write_text(
        json.dumps(cluster_payload, ensure_ascii=True, indent=2), encoding="utf-8"
    )
    print(f"Wrote {len(clusters)} clusters to {clusters_output_path}")


if __name__ == "__main__":
    main()
