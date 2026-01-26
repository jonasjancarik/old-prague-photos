import argparse
import json
import os
import time
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image

import dezoomify


DEFAULT_ARCHIVE_BASE_URL = "https://katalog.ahmp.cz/pragapublica"
DEFAULT_DOWNLOAD_ROOT = "downloads/archive"


@dataclass(frozen=True)
class PhotoHash:
    xid: str
    group_id: str
    hash_value: int
    scan_index: int


class BKNode:
    def __init__(self, hash_value: int, records: list[PhotoHash]) -> None:
        self.hash_value = hash_value
        self.records = records
        self.children: dict[int, "BKNode"] = {}

    def add(self, record: PhotoHash) -> None:
        distance = hamming_distance(self.hash_value, record.hash_value)
        if distance == 0:
            self.records.append(record)
            return
        child = self.children.get(distance)
        if child:
            child.add(record)
        else:
            self.children[distance] = BKNode(record.hash_value, [record])

    def search(self, target: int, max_distance: int, results: list[tuple[PhotoHash, int]]) -> None:
        distance = hamming_distance(self.hash_value, target)
        if distance <= max_distance:
            for record in self.records:
                results.append((record, distance))
        lower = max(0, distance - max_distance)
        upper = distance + max_distance
        for dist in range(lower, upper + 1):
            child = self.children.get(dist)
            if child:
                child.search(target, max_distance, results)


class BKTree:
    def __init__(self) -> None:
        self.root: BKNode | None = None

    def add(self, record: PhotoHash) -> None:
        if self.root is None:
            self.root = BKNode(record.hash_value, [record])
            return
        self.root.add(record)

    def search(self, target: int, max_distance: int) -> list[tuple[PhotoHash, int]]:
        if self.root is None:
            return []
        results: list[tuple[PhotoHash, int]] = []
        self.root.search(target, max_distance, results)
        return results


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
        default=10,
        help="Max Hamming distance for candidate pairs",
    )
    parser.add_argument(
        "--hash-size",
        type=int,
        default=8,
        help="Hash grid size (8 => 64-bit hash)",
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
        "--download-root",
        default=DEFAULT_DOWNLOAD_ROOT,
        help="Root directory for downloaded previews/tiles",
    )
    parser.add_argument(
        "--no-download-cache",
        action="store_true",
        help="Disable local download cache usage",
    )
    return parser.parse_args()


def hamming_distance(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def hash_to_hex(value: int, hash_size: int) -> str:
    width = (hash_size * hash_size) // 4
    return f"{value:0{width}x}"


def dhash(image: Image.Image, hash_size: int) -> int:
    if hash_size < 2:
        raise ValueError("hash_size must be >= 2")
    resample = (
        Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
    )
    thumb = image.convert("L").resize((hash_size + 1, hash_size), resample)
    pixels = list(thumb.getdata())
    width = hash_size + 1
    value = 0
    for row in range(hash_size):
        row_start = row * width
        for col in range(hash_size):
            left = pixels[row_start + col]
            right = pixels[row_start + col + 1]
            value = (value << 1) | (1 if left > right else 0)
    return value


def load_features(path: Path, limit: int) -> list[dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    features = payload.get("features", [])
    items: list[dict[str, object]] = []
    for feature in features:
        props = feature.get("properties", {})
        xid = str(props.get("id", "")).strip()
        group_id = str(props.get("group_id", "")).strip()
        if not xid or not group_id:
            continue
        scan_previews = props.get("scan_previews") or []
        if not isinstance(scan_previews, list):
            scan_previews = []
        items.append({"xid": xid, "group_id": group_id, "scan_previews": scan_previews})
        if limit and len(items) >= limit:
            break
    return items


def load_hash_cache(
    path: Path, force: bool, hash_size: int
) -> dict[tuple[str, int], PhotoHash]:
    if force or not path.exists():
        return {}
    cache: dict[tuple[str, int], PhotoHash] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        xid = str(item.get("xid", "")).strip()
        group_id = str(item.get("group_id", "")).strip()
        raw_hash = item.get("hash")
        cached_size = int(item.get("hash_size") or 0)
        algo = str(item.get("algo") or "").strip()
        if cached_size and cached_size != hash_size:
            continue
        if algo and algo != "dhash":
            continue
        scan_index = item.get("scan_index")
        if scan_index is None:
            scan_index = item.get("scanIndex")
        try:
            scan_index = int(scan_index) if scan_index is not None else 0
        except (TypeError, ValueError):
            scan_index = 0
        if isinstance(raw_hash, int):
            hash_value = raw_hash
        else:
            hash_text = str(raw_hash or "").strip()
            if not hash_text:
                continue
            hash_value = int(hash_text, 16)
        if xid and group_id:
            cache[(xid, scan_index)] = PhotoHash(
                xid=xid,
                group_id=group_id,
                hash_value=hash_value,
                scan_index=scan_index,
            )
    return cache


def append_hash_record(handle, record: PhotoHash, hash_size: int) -> None:
    payload = {
        "xid": record.xid,
        "group_id": record.group_id,
        "hash": hash_to_hex(record.hash_value, hash_size),
        "algo": "dhash",
        "hash_size": hash_size,
        "scan_index": record.scan_index,
    }
    handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


def fetch_zoomify_meta(
    session: requests.Session, xid: str, archive_base_url: str, scan_index: int
) -> tuple[str, int, int, int]:
    scan_param = scan_index + 1 if scan_index >= 0 else 1
    permalink = (
        f"{archive_base_url.rstrip('/')}/permalink?xid={xid}&scan={scan_param}"
    )
    zoomify_html = dezoomify.resolve_zoomify(session, permalink)
    zoomify_img_path = dezoomify.extract_zoomify_img_path(zoomify_html)
    if not zoomify_img_path:
        raise ValueError("zoomifyImgPath not found")
    props = dezoomify.fetch_image_properties(session, zoomify_img_path)
    return zoomify_img_path, props["width"], props["height"], props["tile_size"]


def fetch_preview_tile(
    session: requests.Session, zoomify_img_path: str, width: int, height: int, tile_size: int
) -> Image.Image:
    tiers = dezoomify.build_tiers(width, height, tile_size)
    level = 0
    group = dezoomify.tile_group_index(tiers, tile_size, level, 0, 0)
    tile_url = f"{zoomify_img_path}/TileGroup{group}/{level}-0-0.jpg"
    response = session.get(tile_url, timeout=20)
    response.raise_for_status()
    return Image.open(BytesIO(response.content))


def fetch_preview_image(session: requests.Session, preview_url: str) -> Image.Image:
    response = session.get(preview_url, timeout=20)
    response.raise_for_status()
    return Image.open(BytesIO(response.content))


def compute_preview_hash(
    session: requests.Session,
    preview_url: str,
    hash_size: int,
    local_path: Path | None = None,
) -> int:
    if local_path and local_path.exists():
        with Image.open(local_path) as image:
            return dhash(image, hash_size)
    with fetch_preview_image(session, preview_url) as image:
        return dhash(image, hash_size)


def compute_hash(
    session: requests.Session,
    xid: str,
    archive_base_url: str,
    hash_size: int,
    scan_index: int,
    local_tile_path: Path | None = None,
) -> int:
    if local_tile_path and local_tile_path.exists():
        with Image.open(local_tile_path) as image:
            return dhash(image, hash_size)
    zoomify_img_path, width, height, tile_size = fetch_zoomify_meta(
        session, xid, archive_base_url, scan_index
    )
    with fetch_preview_tile(session, zoomify_img_path, width, height, tile_size) as image:
        return dhash(image, hash_size)


def build_candidates(records: list[PhotoHash], distance: int) -> list[dict[str, str | int]]:
    tree = BKTree()
    pairs: dict[tuple[str, str], dict[str, str | int]] = {}

    for record in records:
        for match, dist in tree.search(record.hash_value, distance):
            if record.group_id == match.group_id:
                continue
            group_a, group_b = sorted([record.group_id, match.group_id])
            key = (group_a, group_b)
            current = pairs.get(key)
            if current is None or dist < int(current["distance"]):
                if group_a == record.group_id:
                    xid_a, xid_b = record.xid, match.xid
                else:
                    xid_a, xid_b = match.xid, record.xid
                pairs[key] = {
                    "group_id_a": group_a,
                    "group_id_b": group_b,
                    "distance": dist,
                    "xid_a": xid_a,
                    "xid_b": xid_b,
                }
        tree.add(record)

    return list(pairs.values())


def build_union_find(ids: list[str]):
    parent = {item: item for item in ids}

    def find(item: str) -> str:
        current = parent.get(item, item)
        if current == item:
            return item
        root = find(current)
        parent[item] = root
        return root

    def union(a: str, b: str) -> None:
        root_a = find(a)
        root_b = find(b)
        if root_a == root_b:
            return
        winner = root_a if root_a < root_b else root_b
        loser = root_b if winner == root_a else root_a
        parent[loser] = winner

    return find, union


def min_distance_between_hashes(hashes_a: list[PhotoHash], hashes_b: list[PhotoHash]) -> int:
    if not hashes_a or not hashes_b:
        return 0
    best = None
    for left in hashes_a:
        for right in hashes_b:
            dist = hamming_distance(left.hash_value, right.hash_value)
            if best is None or dist < best:
                best = dist
                if best == 0:
                    return 0
    return best if best is not None else 0


def build_series_clusters(
    hashes_by_group: dict[str, list[PhotoHash]],
    hashes_by_xid: dict[str, list[PhotoHash]],
    distance: int,
) -> list[dict[str, object]]:
    clusters: list[dict[str, object]] = []
    for group_id, records in hashes_by_group.items():
        xids = sorted({record.xid for record in records})
        if not xids:
            continue
        find, union = build_union_find(xids)

        tree = BKTree()
        for record in records:
            for match, dist in tree.search(record.hash_value, distance):
                if record.xid == match.xid:
                    continue
                union(record.xid, match.xid)
            tree.add(record)

        grouped: dict[str, list[str]] = {}
        for xid in xids:
            root = find(xid)
            grouped.setdefault(root, []).append(xid)

        cluster_list = sorted(
            grouped.values(),
            key=lambda items: (-len(items), ",".join(sorted(items))),
        )
        for idx, cluster_xids in enumerate(cluster_list, start=1):
            cluster_xids = sorted(cluster_xids)
            max_distance = 0
            if len(cluster_xids) > 1:
                for i in range(len(cluster_xids)):
                    for j in range(i + 1, len(cluster_xids)):
                        xid_a = cluster_xids[i]
                        xid_b = cluster_xids[j]
                        dist = min_distance_between_hashes(
                            hashes_by_xid.get(xid_a, []),
                            hashes_by_xid.get(xid_b, []),
                        )
                        if dist > max_distance:
                            max_distance = dist
            clusters.append(
                {
                    "series_id": group_id,
                    "version_id": f"v{idx}",
                    "xids": cluster_xids,
                    "representative_xid": cluster_xids[0],
                    "max_distance": max_distance,
                }
            )
    return clusters


def find_local_preview_path(download_root: Path, xid: str, scan_index: int) -> Path | None:
    previews_dir = download_root / "previews" / xid
    if not previews_dir.exists():
        return None
    candidates = sorted(previews_dir.glob(f"scan_{scan_index}.*"))
    return candidates[0] if candidates else None


def find_local_tile_path(download_root: Path, xid: str, scan_index: int) -> Path | None:
    tiles_dir = download_root / "zoomify" / xid / f"scan_{scan_index}"
    if not tiles_dir.exists():
        return None
    expected = tiles_dir / "TileGroup0" / "0-0-0.jpg"
    if expected.exists():
        return expected
    candidates = sorted(tiles_dir.glob("TileGroup*/0-0-0.jpg"))
    return candidates[0] if candidates else None


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    clusters_output_path = Path(args.clusters_output)
    hash_cache_path = Path(args.hash_cache)
    error_path = hash_cache_path.with_name("errors.jsonl")
    download_root = Path(args.download_root)

    features = load_features(input_path, args.limit)
    cache = load_hash_cache(hash_cache_path, args.force, args.hash_size)
    total_scans = 0
    for item in features:
        previews = item.get("scan_previews") or []
        if not isinstance(previews, list) or not previews:
            total_scans += 1
        else:
            total_scans += len(previews)
    if total_scans:
        print(f"Processing {total_scans} scans across {len(features)} photos")
    processed = 0
    hashed = 0
    cached_count = 0
    error_count = 0
    report_every = max(1, total_scans // 50) if total_scans else 0

    session = requests.Session()
    session.headers.update({"User-Agent": "old-prague-photos/similarity"})

    records_by_key: dict[tuple[str, int], PhotoHash] = dict(cache)
    hash_cache_path.parent.mkdir(parents=True, exist_ok=True)
    error_path.parent.mkdir(parents=True, exist_ok=True)

    cache_mode = "w" if args.force else "a"
    error_mode = "w" if args.force else "a"

    with hash_cache_path.open(cache_mode, encoding="utf-8") as cache_handle, error_path.open(
        error_mode, encoding="utf-8"
    ) as error_handle:
        for item in features:
            xid = str(item["xid"])
            group_id = str(item["group_id"])
            previews = item.get("scan_previews") or []
            if not isinstance(previews, list) or not previews:
                previews = [""]

            for scan_index, preview_url in enumerate(previews):
                preview_url = str(preview_url or "").strip()
                local_preview_path = None
                local_tile_path = None
                if not args.no_download_cache:
                    local_preview_path = find_local_preview_path(
                        download_root, xid, scan_index
                    )
                    local_tile_path = find_local_tile_path(download_root, xid, scan_index)
                key = (xid, scan_index)
                cached = records_by_key.get(key)
                if cached and not args.force:
                    if cached.group_id != group_id:
                        records_by_key[key] = PhotoHash(
                            xid=xid,
                            group_id=group_id,
                            hash_value=cached.hash_value,
                            scan_index=scan_index,
                        )
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
                    hash_value = None
                    if preview_url or local_preview_path:
                        try:
                            hash_value = compute_preview_hash(
                                session,
                                preview_url,
                                args.hash_size,
                                local_path=local_preview_path,
                            )
                        except Exception:
                            if scan_index != 0:
                                raise
                            hash_value = None
                    if hash_value is None:
                        if scan_index == 0:
                            hash_value = compute_hash(
                                session,
                                xid,
                                args.archive_base_url,
                                args.hash_size,
                                scan_index,
                                local_tile_path=local_tile_path,
                            )
                        else:
                            raise ValueError("Preview missing for scan")
                except Exception as exc:
                    error_handle.write(
                        json.dumps(
                            {
                                "xid": xid,
                                "group_id": group_id,
                                "scan_index": scan_index,
                                "preview_url": preview_url,
                                "error": str(exc),
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

                record = PhotoHash(
                    xid=xid,
                    group_id=group_id,
                    hash_value=hash_value,
                    scan_index=scan_index,
                )
                records_by_key[key] = record
                append_hash_record(cache_handle, record, args.hash_size)
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

    hashes_by_xid: dict[str, list[PhotoHash]] = {}
    hashes_by_group: dict[str, list[PhotoHash]] = {}
    xids_in_features = {str(item["xid"]) for item in features}
    for record in records_by_key.values():
        if record.xid not in xids_in_features:
            continue
        hashes_by_xid.setdefault(record.xid, []).append(record)
        hashes_by_group.setdefault(record.group_id, []).append(record)

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

    candidates = build_candidates(records, args.distance)
    clusters = build_series_clusters(hashes_by_group, hashes_by_xid, args.distance)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "distance": args.distance,
        "hash_size": args.hash_size,
        "algo": "dhash",
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
        "distance": args.distance,
        "hash_size": args.hash_size,
        "algo": "dhash",
        "clusters": clusters,
    }
    clusters_output_path.write_text(
        json.dumps(cluster_payload, ensure_ascii=True, indent=2), encoding="utf-8"
    )
    print(f"Wrote {len(clusters)} clusters to {clusters_output_path}")


if __name__ == "__main__":
    main()
