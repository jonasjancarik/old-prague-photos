import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageFilter


@dataclass(frozen=True)
class PhotoHash:
    xid: str
    group_id: str
    hash_value: int
    scan_index: int


@dataclass(frozen=True)
class HashCacheEntry:
    xid: str
    group_id: str
    hash_value: int
    scan_index: int
    hash_profile: str
    image_source: str
    render_mode: str
    image_width: int
    image_height: int


@dataclass(frozen=True)
class ScanInput:
    scan_index: int
    preview_url: str
    feature_zoomify_path: str


@dataclass(frozen=True)
class HashResult:
    hash_value: int
    image_source: str
    render_mode: str
    image_width: int
    image_height: int


@dataclass(frozen=True)
class LevelInfo:
    level: int
    width: int
    height: int
    tiles_x: int
    tiles_y: int
    tile_count: int
    long_side: int


class HashSourceError(RuntimeError):
    def __init__(self, message: str, source_attempts: list[dict[str, str]]) -> None:
        super().__init__(message)
        self.source_attempts = source_attempts


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


def hamming_distance(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def hash_to_hex(value: int, hash_size: int) -> str:
    width = max((hash_size * hash_size) // 4, (value.bit_length() + 3) // 4, 1)
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


def edge_hash(image: Image.Image, hash_size: int) -> int:
    if hash_size < 2:
        raise ValueError("hash_size must be >= 2")
    resample = (
        Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
    )
    edge_image = (
        image.convert("L")
        .filter(ImageFilter.FIND_EDGES)
        .resize((hash_size, hash_size), resample)
    )
    pixels = list(edge_image.getdata())
    average = sum(pixels) / len(pixels) if pixels else 0
    value = 0
    for pixel in pixels:
        value = (value << 1) | (1 if pixel > average else 0)
    return value


def visual_hash(image: Image.Image, hash_size: int) -> int:
    component_bits = hash_size * hash_size
    return (dhash(image, hash_size) << component_bits) | edge_hash(image, hash_size)


def sanitize_scan_count(value: object) -> int:
    try:
        scan_count = int(value)
        if scan_count > 0:
            return scan_count
    except (TypeError, ValueError):
        pass
    return 0


def parse_scan_inputs(
    scan_count: int,
    scan_previews: list[str],
    scan_zoomify_paths: list[str],
) -> list[ScanInput]:
    inferred_count = max(scan_count, len(scan_previews), len(scan_zoomify_paths), 1)
    scans: list[ScanInput] = []
    for scan_index in range(inferred_count):
        preview_url = scan_previews[scan_index] if scan_index < len(scan_previews) else ""
        feature_zoomify_path = (
            scan_zoomify_paths[scan_index] if scan_index < len(scan_zoomify_paths) else ""
        )
        scans.append(
            ScanInput(
                scan_index=scan_index,
                preview_url=str(preview_url or "").strip(),
                feature_zoomify_path=str(feature_zoomify_path or "").strip().rstrip("/"),
            )
        )
    return scans


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
        raw_previews = props.get("scan_previews") or []
        raw_zoomify_paths = props.get("scan_zoomify_paths") or []
        scan_previews = (
            [str(item or "").strip() for item in raw_previews]
            if isinstance(raw_previews, list)
            else []
        )
        scan_zoomify_paths = (
            [str(item or "").strip().rstrip("/") for item in raw_zoomify_paths]
            if isinstance(raw_zoomify_paths, list)
            else []
        )
        scan_count = sanitize_scan_count(props.get("scan_count"))
        scans = parse_scan_inputs(scan_count, scan_previews, scan_zoomify_paths)
        items.append(
            {
                "xid": xid,
                "group_id": group_id,
                "scans": scans,
            }
        )
        if limit and len(items) >= limit:
            break
    return items


def parse_hash_value(raw_hash: object) -> int | None:
    if isinstance(raw_hash, int):
        return raw_hash
    hash_text = str(raw_hash or "").strip()
    if not hash_text:
        return None
    try:
        return int(hash_text, 16)
    except ValueError:
        return None


def parse_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def load_hash_cache(
    path: Path,
    force: bool,
    hash_size: int,
    hash_profile: str,
    expected_algo: str = "dhash",
) -> dict[tuple[str, int], HashCacheEntry]:
    if force or not path.exists():
        return {}
    cache: dict[tuple[str, int], HashCacheEntry] = {}
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
        cached_size = parse_int(item.get("hash_size"), 0)
        cached_algo = str(item.get("algo") or "").strip()
        cached_profile = str(item.get("hash_profile") or "").strip()
        if cached_size and cached_size != hash_size:
            continue
        if cached_algo and cached_algo != expected_algo:
            continue
        if cached_profile != hash_profile:
            continue
        scan_index = item.get("scan_index")
        if scan_index is None:
            scan_index = item.get("scanIndex")
        scan_index = parse_int(scan_index, 0)
        hash_value = parse_hash_value(item.get("hash"))
        if hash_value is None or not xid or not group_id:
            continue
        entry = HashCacheEntry(
            xid=xid,
            group_id=group_id,
            hash_value=hash_value,
            scan_index=scan_index,
            hash_profile=hash_profile,
            image_source=str(item.get("image_source") or "").strip(),
            render_mode=str(item.get("render_mode") or "").strip(),
            image_width=max(0, parse_int(item.get("image_width"), 0)),
            image_height=max(0, parse_int(item.get("image_height"), 0)),
        )
        cache[(xid, scan_index)] = entry
    return cache


def append_hash_record(
    handle,
    record: HashCacheEntry,
    hash_size: int,
    algo: str = "dhash",
) -> None:
    payload = {
        "xid": record.xid,
        "group_id": record.group_id,
        "hash": hash_to_hex(record.hash_value, hash_size),
        "algo": algo,
        "hash_size": hash_size,
        "scan_index": record.scan_index,
        "hash_profile": record.hash_profile,
        "image_source": record.image_source,
        "render_mode": record.render_mode,
        "image_width": record.image_width,
        "image_height": record.image_height,
    }
    handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


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
            for match, _ in tree.search(record.hash_value, distance):
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
