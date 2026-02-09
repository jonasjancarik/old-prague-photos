import argparse
import json
import random
from collections import Counter, deque
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlsplit, urlunsplit

import requests

import dezoomify


DEFAULT_ARCHIVE_BASE_URL = "https://katalog.ahmp.cz/pragapublica"
SCAN_COUNT_PATTERN = re.compile(r"(\d+)\s+obrázk", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download preview images and full Zoomify tiles with resume support",
    )
    parser.add_argument(
        "--input",
        default="viewer/static/data/photos.geojson",
        help="GeoJSON input with photo metadata",
    )
    parser.add_argument(
        "--output-dir",
        default="downloads/archive",
        help="Root directory for downloaded assets",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=10.0,
        help="Delay between photos (seconds)",
    )
    parser.add_argument(
        "--tile-sleep",
        type=float,
        default=0.05,
        help="Delay between tile requests (seconds)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Limit number of photos (0 = all)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=20.0,
        help="Request timeout (seconds)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=4,
        help="Retry attempts for failed downloads",
    )
    parser.add_argument(
        "--retry-sleep",
        type=float,
        default=5.0,
        help="Delay between retries (seconds)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Redownload files even if they exist",
    )
    parser.add_argument(
        "--retry-missing",
        action="store_true",
        help="Retry scans marked as missing",
    )
    parser.add_argument(
        "--archive-base-url",
        default=DEFAULT_ARCHIVE_BASE_URL,
        help="Base URL for archive permalinks",
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Only report local cache stats (no network)",
    )
    parser.add_argument(
        "--previews-only",
        action="store_true",
        help="Download only preview images and skip Zoomify tiles",
    )
    parser.add_argument(
        "--raw-records-dir",
        default="output/raw_records",
        help="Fallback source for scan_previews when GeoJSON preview metadata is missing",
    )
    parser.add_argument(
        "--resolve-missing-previews",
        dest="resolve_missing_previews",
        action="store_true",
        default=True,
        help="Resolve missing preview URLs from archive permalinks by xid",
    )
    parser.add_argument(
        "--no-resolve-missing-previews",
        dest="resolve_missing_previews",
        action="store_false",
        help="Disable archive lookup for missing preview metadata",
    )
    parser.add_argument(
        "--resolved-previews-cache",
        default="downloads/archive/resolved_previews.jsonl",
        help="Cache for archive-resolved preview URLs (JSONL)",
    )
    parser.add_argument(
        "--resolve-timeout",
        type=float,
        default=12.0,
        help="Timeout (seconds) for preview URL resolution requests",
    )
    parser.add_argument(
        "--resolve-retries",
        type=int,
        default=1,
        help="Retry attempts for preview URL resolution requests",
    )
    parser.add_argument(
        "--resolve-retry-sleep",
        type=float,
        default=1.0,
        help="Delay between preview URL resolution retries (seconds)",
    )
    parser.add_argument(
        "--resolve-max-seconds",
        type=float,
        default=45.0,
        help="Maximum time budget per xid while resolving missing preview URLs",
    )
    return parser.parse_args()


def normalize_previews(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item or "").strip() for item in value]


def has_any_preview(previews: list[str]) -> bool:
    return any(previews)


def load_raw_record_previews(raw_records_dir: Path, xid: str) -> list[str]:
    path = raw_records_dir / f"{xid}.json"
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(payload, dict):
        return []
    return normalize_previews(payload.get("scan_previews"))


def load_items(
    path: Path,
    limit: int,
    raw_records_dir: Path | None = None,
) -> list[dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    features = payload.get("features", [])
    items: list[dict[str, object]] = []
    for feature in features:
        props = feature.get("properties", {})
        xid = str(props.get("id", "")).strip()
        scan_previews = normalize_previews(props.get("scan_previews"))
        if raw_records_dir and xid and not has_any_preview(scan_previews):
            raw_previews = load_raw_record_previews(raw_records_dir, xid)
            if has_any_preview(raw_previews):
                scan_previews = raw_previews
        if xid:
            items.append({"xid": xid, "scan_previews": scan_previews})
        if limit and len(items) >= limit:
            break
    return items


def parse_scan_count(page_html: str) -> int | None:
    match = SCAN_COUNT_PATTERN.search(page_html)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def with_scan_index(url: str, scan_index: int) -> str:
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    query["scanIndex"] = [str(scan_index)]
    new_query = urlencode(query, doseq=True)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))


def build_preview_url(zoomify_img_path: str) -> str:
    base = zoomify_img_path.replace("/zoomify/", "/image/").rstrip("/")
    return f"{base}/nahled_maly.jpg"


def load_resolved_previews_cache(path: Path) -> dict[str, list[str]]:
    if not path.exists():
        return {}
    result: dict[str, list[str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        xid = str(payload.get("xid", "")).strip()
        previews = normalize_previews(payload.get("scan_previews"))
        if xid and has_any_preview(previews):
            result[xid] = previews
    return result


def append_resolved_previews_cache(path: Path, xid: str, previews: list[str]) -> None:
    if not xid or not has_any_preview(previews):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"xid": xid, "scan_previews": previews}
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


def resolve_preview_urls_from_permalink(
    session: requests.Session,
    xid: str,
    args: argparse.Namespace,
) -> list[str]:
    resolve_timeout = float(getattr(args, "resolve_timeout", args.timeout))
    resolve_retries = int(getattr(args, "resolve_retries", args.retries))
    resolve_retry_sleep = float(getattr(args, "resolve_retry_sleep", args.retry_sleep))
    resolve_max_seconds = float(getattr(args, "resolve_max_seconds", 45.0))
    started = time.time()

    def within_budget() -> None:
        if resolve_max_seconds <= 0:
            return
        elapsed = time.time() - started
        if elapsed > resolve_max_seconds:
            raise TimeoutError(
                f"Preview resolution exceeded {resolve_max_seconds:.1f}s budget"
            )

    base = args.archive_base_url.rstrip("/")
    permalink = f"{base}/permalink?xid={xid}"
    within_budget()
    page_html = dezoomify.fetch_zoomify_page(
        session,
        permalink,
        timeout=resolve_timeout,
        retries=resolve_retries,
        retry_sleep=resolve_retry_sleep,
    )
    zoomify_url = dezoomify.extract_zoomify_url(page_html, permalink)
    if not zoomify_url:
        zoomify_img_path = dezoomify.extract_zoomify_img_path(page_html)
        if not zoomify_img_path:
            return []
        return [build_preview_url(zoomify_img_path)]

    scan_count = parse_scan_count(page_html)
    if scan_count is None or scan_count <= 0:
        scan_count = 1

    previews: list[str] = []
    for scan_index in range(scan_count):
        try:
            within_budget()
            zoomify_scan_url = with_scan_index(zoomify_url, scan_index)
            zoomify_html = dezoomify.fetch_zoomify_page(
                session,
                zoomify_scan_url,
                timeout=resolve_timeout,
                retries=resolve_retries,
                retry_sleep=resolve_retry_sleep,
            )
            zoomify_img_path = dezoomify.extract_zoomify_img_path(zoomify_html)
            previews.append(build_preview_url(zoomify_img_path) if zoomify_img_path else "")
        except Exception:
            previews.append("")

    if has_any_preview(previews):
        return previews

    # Fallback: try resolver for first scan when scan-specific probing fails.
    within_budget()
    zoomify_html = dezoomify.resolve_zoomify(
        session,
        permalink,
        timeout=resolve_timeout,
        retries=resolve_retries,
        retry_sleep=resolve_retry_sleep,
    )
    zoomify_img_path = dezoomify.extract_zoomify_img_path(zoomify_html)
    if not zoomify_img_path:
        return []
    return [build_preview_url(zoomify_img_path)]


def url_extension(url: str, fallback: str = ".jpg") -> str:
    if not url:
        return fallback
    path = urlparse(url).path
    suffix = Path(path).suffix
    return suffix if suffix else fallback


def parse_image_properties_xml(text: str) -> dict[str, int]:
    def find_int(attr: str) -> int:
        match = re.search(rf'{attr}="(\d+)"', text)
        if not match:
            raise ValueError(f"Missing {attr} in ImageProperties.xml")
        return int(match.group(1))

    return {
        "width": find_int("WIDTH"),
        "height": find_int("HEIGHT"),
        "tile_size": find_int("TILESIZE"),
    }


def load_local_image_properties(path: Path) -> dict[str, int] | None:
    if not path.exists():
        return None
    return parse_image_properties_xml(path.read_text(encoding="utf-8"))


def find_existing_preview(previews_dir: Path, xid: str, scan_index: int) -> Path | None:
    scan_dir = previews_dir / xid
    if not scan_dir.exists():
        return None
    candidates = sorted(scan_dir.glob(f"scan_{scan_index}.*"))
    return candidates[0] if candidates else None


def is_tiles_complete(tiles_dir: Path, props: dict[str, int]) -> bool:
    tiers = dezoomify.build_tiers(
        props["width"],
        props["height"],
        props["tile_size"],
    )
    expected = 0
    for size in tiers:
        tiles_x, tiles_y = dezoomify.tiles_for(size, props["tile_size"])
        expected += tiles_x * tiles_y
    existing = sum(1 for _ in tiles_dir.glob("TileGroup*/*.jpg"))
    return existing >= expected


def scan_complete_marker(tiles_dir: Path) -> Path:
    return tiles_dir / "scan_complete.json"


def scan_missing_marker(tiles_dir: Path) -> Path:
    return tiles_dir / "scan_missing.json"


def is_photo_cached(
    xid: str,
    previews: list[str],
    previews_dir: Path,
    tiles_root: Path,
    *,
    include_missing: bool,
) -> bool:
    for scan_index, preview_url in enumerate(previews):
        preview_url = str(preview_url or "").strip()
        preview_cached = True
        if preview_url:
            preview_cached = find_existing_preview(previews_dir, xid, scan_index) is not None
        tiles_dir = tiles_root / xid / f"scan_{scan_index}"
        tiles_cached = scan_complete_marker(tiles_dir).exists()
        if include_missing:
            tiles_cached = tiles_cached or scan_missing_marker(tiles_dir).exists()
        if not (tiles_cached and preview_cached):
            return False
    return True


def count_existing_tiles(tiles_dir: Path) -> int:
    return sum(1 for _ in tiles_dir.glob("TileGroup*/*.jpg"))


def scan_tile_stats(tiles_dir: Path) -> dict[str, int | bool]:
    marker = scan_complete_marker(tiles_dir)
    missing_marker = scan_missing_marker(tiles_dir)
    marker_exists = marker.exists()
    missing_exists = missing_marker.exists()
    unavailable = missing_exists and not marker_exists
    props_path = tiles_dir / "ImageProperties.xml"
    props = load_local_image_properties(props_path)
    existing = count_existing_tiles(tiles_dir)
    if not props:
        return {
            "expected": 0,
            "existing": existing,
            "missing": 0,
            "complete": marker_exists,
            "partial": existing > 0 and not marker_exists,
            "missing_all": existing == 0,
            "has_props": False,
            "unavailable": unavailable,
        }
    tiers = dezoomify.build_tiers(
        props["width"],
        props["height"],
        props["tile_size"],
    )
    expected = 0
    for size in tiers:
        tiles_x, tiles_y = dezoomify.tiles_for(size, props["tile_size"])
        expected += tiles_x * tiles_y
    missing = max(expected - existing, 0)
    complete = marker_exists or (existing >= expected and expected > 0)
    partial = existing > 0 and not complete
    return {
        "expected": expected,
        "existing": existing,
        "missing": missing,
        "complete": complete,
        "partial": partial,
        "missing_all": existing == 0,
        "has_props": True,
        "unavailable": unavailable,
    }


def print_stats(items: list[dict[str, object]], previews_dir: Path, tiles_root: Path) -> None:
    photo_complete = 0
    photo_partial = 0
    photo_missing = 0
    photo_empty = 0

    scan_complete = 0
    scan_partial = 0
    scan_missing = 0
    scan_no_props = 0
    scan_unavailable = 0

    tiles_expected = 0
    tiles_existing = 0
    tiles_missing = 0

    preview_expected = 0
    preview_present = 0
    preview_missing = 0
    preview_unknown = 0

    for item in items:
        xid = str(item["xid"])
        known_previews = normalize_previews(item.get("scan_previews"))
        if known_previews:
            previews = known_previews
        else:
            preview_unknown += 1
            previews = [""]

        photo_has_partial = False
        photo_has_missing = False
        photo_all_missing = True
        photo_all_complete = True

        for scan_index, preview_url in enumerate(previews):
            preview_url = str(preview_url or "").strip()
            if preview_url:
                preview_expected += 1
                if find_existing_preview(previews_dir, xid, scan_index):
                    preview_present += 1
                else:
                    preview_missing += 1

            tiles_dir = tiles_root / xid / f"scan_{scan_index}"
            stats = scan_tile_stats(tiles_dir)
            if not stats["has_props"]:
                scan_no_props += 1
            if stats.get("unavailable"):
                scan_unavailable += 1

            if stats["complete"]:
                scan_complete += 1
            elif stats["partial"]:
                scan_partial += 1
            else:
                scan_missing += 1

            if stats["partial"]:
                photo_has_partial = True
            if not stats["complete"]:
                photo_all_complete = False
            if stats["missing_all"]:
                photo_has_missing = True
            else:
                photo_all_missing = False

            if stats["expected"]:
                tiles_expected += int(stats["expected"])
                tiles_existing += int(stats["existing"])
                tiles_missing += int(stats["missing"])

        if photo_all_complete:
            photo_complete += 1
        elif photo_has_partial:
            photo_partial += 1
        elif photo_has_missing:
            photo_missing += 1
        if photo_all_missing:
            photo_empty += 1

    print("Cache stats")
    print(f"Photos: total={len(items)} complete={photo_complete} partial={photo_partial} missing={photo_missing} empty={photo_empty}")
    print(
        "Scans: "
        f"complete={scan_complete} partial={scan_partial} missing={scan_missing} "
        f"unavailable={scan_unavailable} no_props={scan_no_props}"
    )
    print(f"Tiles: expected={tiles_expected} existing={tiles_existing} missing={tiles_missing}")
    print(
        f"Previews: expected={preview_expected} present={preview_present} "
        f"missing={preview_missing} unknown={preview_unknown}"
    )


def fetch_bytes(
    session: requests.Session,
    url: str,
    timeout: float,
    retries: int,
    retry_sleep: float,
) -> bytes:
    last_exc = None
    for attempt in range(retries + 1):
        try:
            response = session.get(url, timeout=timeout)
            response.raise_for_status()
            return response.content
        except Exception as exc:
            last_exc = exc
            if attempt < retries:
                backoff = retry_sleep * (2 ** attempt)
                if isinstance(exc, requests.HTTPError) and exc.response is not None:
                    if exc.response.status_code in {403, 429}:
                        backoff = max(backoff, 10 * (attempt + 1))
                    retry_after = exc.response.headers.get("Retry-After")
                    if retry_after:
                        try:
                            backoff = max(backoff, int(retry_after))
                        except ValueError:
                            pass
                backoff += random.uniform(0, retry_sleep)
                time.sleep(backoff)
    raise last_exc if last_exc else RuntimeError("Download failed")


def write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def log_error(handle, payload: dict[str, object]) -> None:
    handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


def format_eta(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    total = int(seconds)
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def classify_error(exc: Exception) -> str:
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        status = exc.response.status_code
        if status == 429:
            return "rate_limited"
        if status == 403:
            return "forbidden"
        if status in {500, 502, 503, 504}:
            return "overloaded"
        return f"http_{status}"
    if isinstance(exc, requests.Timeout):
        return "timeout"
    message = str(exc)
    if "Read timed out" in message or "ConnectTimeout" in message:
        return "timeout"
    if "RemoteDisconnected" in message or "Connection reset" in message:
        return "overloaded"
    if "Failed to resolve Zoomify image" in message:
        return "resolve_failed"
    return "other"


def format_error_summary(counter: Counter) -> str:
    if not counter:
        return ""
    parts = []
    if counter.get("rate_limited"):
        parts.append(f"rate_limited={counter['rate_limited']}")
    if counter.get("overloaded"):
        parts.append(f"overloaded={counter['overloaded']}")
    if counter.get("forbidden"):
        parts.append(f"forbidden={counter['forbidden']}")
    if counter.get("timeout"):
        parts.append(f"timeout={counter['timeout']}")
    known = sum(counter.get(key, 0) for key in ("rate_limited", "overloaded", "forbidden", "timeout"))
    other = sum(counter.values()) - known
    if other:
        parts.append(f"other={other}")
    return " errors(" + " ".join(parts) + ")"


def compact_error(message: str, max_len: int = 120) -> str:
    cleaned = " ".join(message.strip().split())
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 3] + "..."


def format_other_samples(samples: deque[str]) -> str:
    if not samples:
        return ""
    joined = " | ".join(samples)
    return f' error_samples="{joined}"'


def download_preview(
    session: requests.Session,
    preview_url: str,
    target_path: Path,
    already_exists: bool,
    args: argparse.Namespace,
) -> bool:
    if already_exists and not args.force:
        return False
    content = fetch_bytes(
        session,
        preview_url,
        args.timeout,
        args.retries,
        args.retry_sleep,
    )
    write_bytes(target_path, content)
    return True


def download_zoomify_tiles(
    session: requests.Session,
    xid: str,
    scan_index: int,
    tiles_dir: Path,
    args: argparse.Namespace,
) -> int:
    marker_path = scan_complete_marker(tiles_dir)
    missing_path = scan_missing_marker(tiles_dir)
    if marker_path.exists() and not args.force:
        return 0
    if missing_path.exists() and not (args.force or args.retry_missing):
        return 0
    scan_param = scan_index + 1 if scan_index >= 0 else 1
    permalink = f"{args.archive_base_url.rstrip('/')}/permalink?xid={xid}&scan={scan_param}"
    try:
        zoomify_html = dezoomify.resolve_zoomify(
            session,
            permalink,
            timeout=args.timeout,
            retries=args.retries,
            retry_sleep=args.retry_sleep,
        )
    except dezoomify.ZoomifyNotFoundError as exc:
        missing_path.parent.mkdir(parents=True, exist_ok=True)
        missing_path.write_text(
            json.dumps(
                {
                    "xid": xid,
                    "scan_index": scan_index,
                    "reason": exc.reason,
                },
                ensure_ascii=True,
            ),
            encoding="utf-8",
        )
        return 0
    if missing_path.exists():
        try:
            missing_path.unlink()
        except OSError:
            pass
    zoomify_img_path = dezoomify.extract_zoomify_img_path(zoomify_html)
    if not zoomify_img_path:
        raise ValueError("zoomifyImgPath not found")

    props_path = tiles_dir / "ImageProperties.xml"
    props = load_local_image_properties(props_path)
    if props is None or args.force:
        props = dezoomify.fetch_image_properties(
            session,
            zoomify_img_path,
            timeout=args.timeout,
            retries=args.retries,
            retry_sleep=args.retry_sleep,
        )
        props_xml = fetch_bytes(
            session,
            f"{zoomify_img_path}/ImageProperties.xml",
            args.timeout,
            args.retries,
            args.retry_sleep,
        )
        write_bytes(props_path, props_xml)
    if props and not args.force:
        if is_tiles_complete(tiles_dir, props):
            marker_path.write_text(
                json.dumps({"xid": xid, "scan_index": scan_index}, ensure_ascii=True),
                encoding="utf-8",
            )
            return 0

    tiers = dezoomify.build_tiers(
        props["width"],
        props["height"],
        props["tile_size"],
    )
    downloaded = 0
    for z, size in enumerate(tiers):
        tiles_x, tiles_y = dezoomify.tiles_for(size, props["tile_size"])
        for tile_y in range(tiles_y):
            for tile_x in range(tiles_x):
                group = dezoomify.tile_group_index(
                    tiers, props["tile_size"], z, tile_x, tile_y
                )
                tile_rel = Path(f"TileGroup{group}") / f"{z}-{tile_x}-{tile_y}.jpg"
                tile_path = tiles_dir / tile_rel
                if tile_path.exists() and not args.force:
                    continue
                tile_url = f"{zoomify_img_path}/{tile_rel.as_posix()}"
                content = fetch_bytes(
                    session,
                    tile_url,
                    args.timeout,
                    args.retries,
                    args.retry_sleep,
                )
                write_bytes(tile_path, content)
                downloaded += 1
                if args.tile_sleep:
                    time.sleep(args.tile_sleep)
    marker_path.write_text(
        json.dumps({"xid": xid, "scan_index": scan_index}, ensure_ascii=True),
        encoding="utf-8",
    )
    return downloaded


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    previews_dir = output_dir / "previews"
    tiles_root = output_dir / "zoomify"
    error_path = output_dir / "errors.jsonl"
    raw_records_dir = Path(args.raw_records_dir) if args.raw_records_dir else None
    if raw_records_dir and not raw_records_dir.exists():
        raw_records_dir = None
    resolved_cache_path = Path(args.resolved_previews_cache)
    resolved_previews_cache = (
        load_resolved_previews_cache(resolved_cache_path)
        if args.resolve_missing_previews
        else {}
    )
    resolved_cache_seen = set(resolved_previews_cache)

    items = load_items(input_path, args.limit, raw_records_dir=raw_records_dir)
    if resolved_previews_cache:
        for item in items:
            xid = str(item["xid"])
            previews = normalize_previews(item.get("scan_previews"))
            if has_any_preview(previews):
                continue
            cached_previews = resolved_previews_cache.get(xid, [])
            if has_any_preview(cached_previews):
                item["scan_previews"] = cached_previews
    if not items:
        print("No photos found")
        return
    if args.stats:
        print_stats(items, previews_dir, tiles_root)
        return

    session = requests.Session()
    session.headers.update({"User-Agent": "old-prague-photos/archive-download"})

    total = len(items)
    processed = 0
    skipped = 0
    downloaded = 0
    errors = 0
    error_counts: Counter[str] = Counter()
    other_samples: deque[str] = deque(maxlen=3)
    initial_cached = 0
    cached_xids: set[str] = set()
    work_done = 0
    work_elapsed = 0.0

    include_missing = not args.retry_missing
    if not args.force:
        for item in items:
            xid = str(item["xid"])
            known_previews = normalize_previews(item.get("scan_previews"))
            if args.previews_only:
                if has_any_preview(known_previews):
                    preview_cached = True
                    for scan_index, preview_url in enumerate(known_previews):
                        preview_url = str(preview_url or "").strip()
                        if preview_url and not find_existing_preview(previews_dir, xid, scan_index):
                            preview_cached = False
                            break
                else:
                    preview_cached = find_existing_preview(previews_dir, xid, 0) is not None
                cached = preview_cached
            else:
                previews = known_previews if known_previews else [""]
                cached = is_photo_cached(
                    xid,
                    previews,
                    previews_dir,
                    tiles_root,
                    include_missing=include_missing,
                )
            if cached:
                initial_cached += 1
                cached_xids.add(xid)
        if initial_cached:
            percent_cached = (initial_cached / total) * 100
            print(
                f"Initial cache: {initial_cached}/{total} ({percent_cached:.1f}%)"
            )

    output_dir.mkdir(parents=True, exist_ok=True)
    with error_path.open("a", encoding="utf-8") as error_handle:
        start_time = time.time()
        for item in items:
            photo_start = time.time()
            xid = str(item["xid"])
            previews = normalize_previews(item.get("scan_previews"))

            photo_downloaded = False
            photo_error = False
            photo_cached = True
            preview_urls_resolved = False
            photo_rate_limited = False

            if args.previews_only and not has_any_preview(previews):
                existing_fallback_preview = find_existing_preview(previews_dir, xid, 0)
                if existing_fallback_preview and not args.force:
                    previews = [""]
                elif args.resolve_missing_previews:
                    resolve_start = time.time()
                    print(f"Resolving preview URLs xid={xid}...", flush=True)
                    try:
                        resolved_previews = resolve_preview_urls_from_permalink(
                            session,
                            xid,
                            args,
                        )
                        if has_any_preview(resolved_previews):
                            previews = resolved_previews
                            item["scan_previews"] = resolved_previews
                            preview_urls_resolved = True
                            resolve_elapsed = time.time() - resolve_start
                            print(
                                f"Resolved preview URLs xid={xid} scans={len(resolved_previews)} in {resolve_elapsed:.1f}s",
                                flush=True,
                            )
                            if xid not in resolved_cache_seen:
                                append_resolved_previews_cache(
                                    resolved_cache_path, xid, resolved_previews
                                )
                                resolved_cache_seen.add(xid)
                        else:
                            previews = [""]
                            photo_cached = False
                            photo_error = True
                            error_counts["resolve_failed"] += 1
                            resolve_elapsed = time.time() - resolve_start
                            print(
                                f"Resolve failed xid={xid} in {resolve_elapsed:.1f}s (no preview URLs)",
                                flush=True,
                            )
                            other_samples.append(
                                compact_error("Failed to resolve preview URLs")
                            )
                            log_error(
                                error_handle,
                                {
                                    "xid": xid,
                                    "stage": "resolve_preview_urls",
                                    "error": "No preview URLs resolved",
                                },
                            )
                    except Exception as exc:
                        previews = [""]
                        photo_cached = False
                        photo_error = True
                        category = classify_error(exc)
                        error_counts[category] += 1
                        if category == "rate_limited":
                            photo_rate_limited = True
                        resolve_elapsed = time.time() - resolve_start
                        print(
                            f"Resolve error xid={xid} in {resolve_elapsed:.1f}s: {compact_error(str(exc), max_len=80)}",
                            flush=True,
                        )
                        if category not in {"rate_limited", "overloaded", "forbidden", "timeout"}:
                            other_samples.append(compact_error(str(exc)))
                        log_error(
                            error_handle,
                            {
                                "xid": xid,
                                "stage": "resolve_preview_urls",
                                "error": str(exc),
                            },
                        )
                else:
                    previews = [""]
            elif not previews:
                previews = [""]

            for scan_index, preview_url in enumerate(previews):
                preview_url = str(preview_url or "").strip()
                existing_preview = find_existing_preview(previews_dir, xid, scan_index)
                preview_cached = existing_preview is not None and not args.force
                if preview_url:
                    preview_ext = url_extension(preview_url)
                    preview_path = previews_dir / xid / f"scan_{scan_index}{preview_ext}"
                    try:
                        did_download = download_preview(
                            session,
                            preview_url,
                            preview_path,
                            preview_cached,
                            args,
                        )
                        if did_download:
                            photo_downloaded = True
                    except Exception as exc:
                        photo_error = True
                        category = classify_error(exc)
                        error_counts[category] += 1
                        if category == "rate_limited":
                            photo_rate_limited = True
                        if category not in {"rate_limited", "overloaded", "forbidden", "timeout"}:
                            other_samples.append(compact_error(str(exc)))
                        log_error(
                            error_handle,
                            {
                                "xid": xid,
                                "scan_index": scan_index,
                                "preview_url": preview_url,
                                "error": str(exc),
                            },
                        )
                elif preview_cached:
                    preview_cached = True

                if not args.previews_only:
                    tiles_dir = tiles_root / xid / f"scan_{scan_index}"
                    try:
                        downloaded_tiles = download_zoomify_tiles(
                            session, xid, scan_index, tiles_dir, args
                        )
                        if downloaded_tiles:
                            photo_downloaded = True
                    except Exception as exc:
                        photo_error = True
                        category = classify_error(exc)
                        error_counts[category] += 1
                        if category == "rate_limited":
                            photo_rate_limited = True
                        if category not in {"rate_limited", "overloaded", "forbidden", "timeout"}:
                            other_samples.append(compact_error(str(exc)))
                        log_error(
                            error_handle,
                            {
                                "xid": xid,
                                "scan_index": scan_index,
                                "permalink_scan": scan_index + 1,
                                "error": str(exc),
                            },
                        )

                if args.force:
                    photo_cached = False
                else:
                    if args.previews_only:
                        photo_cached = photo_cached and (preview_cached or not preview_url)
                    else:
                        tiles_cached = scan_complete_marker(tiles_dir).exists() or scan_missing_marker(tiles_dir).exists()
                        photo_cached = photo_cached and tiles_cached and (preview_cached or not preview_url)

            if photo_error:
                errors += 1
            if photo_downloaded:
                downloaded += 1
            elif photo_cached:
                skipped += 1
            if not args.force and xid not in cached_xids:
                work_done += 1
                work_elapsed += time.time() - photo_start
            processed += 1
            if total:
                percent = (processed / total) * 100
                status = "downloaded" if photo_downloaded else "cached" if photo_cached else "partial"
                if preview_urls_resolved and not photo_downloaded and not photo_error:
                    status = "resolved"
                eta = ""
                if total and initial_cached:
                    remaining_work = max(total - initial_cached - work_done, 0)
                    if work_done > 0:
                        avg = work_elapsed / work_done
                        eta = format_eta(avg * remaining_work)
                elif processed:
                    elapsed = time.time() - start_time
                    avg = elapsed / processed
                    remaining = total - processed
                    eta = format_eta(avg * remaining)
                print(
                    f"Progress {processed}/{total} ({percent:.1f}%) xid={xid} [{status}] "
                    f"downloaded={downloaded} cached={skipped} errors={errors} eta={eta}"
                    f" cached_total={initial_cached}"
                    f" work={work_done}/{max(total - initial_cached, 0)}"
                    f"{format_error_summary(error_counts)}"
                    f"{format_other_samples(other_samples)}"
                )
            if args.sleep and (photo_downloaded or photo_error):
                sleep_s = float(args.sleep)
                if photo_rate_limited:
                    sleep_s = max(sleep_s, 15.0)
                time.sleep(sleep_s)


if __name__ == "__main__":
    main()
