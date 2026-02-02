import argparse
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import requests

import dezoomify


DEFAULT_ARCHIVE_BASE_URL = "https://katalog.ahmp.cz/pragapublica"


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
        default=0.0,
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
        default=2,
        help="Retry attempts for failed downloads",
    )
    parser.add_argument(
        "--retry-sleep",
        type=float,
        default=2.0,
        help="Delay between retries (seconds)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Redownload files even if they exist",
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
    return parser.parse_args()


def load_items(path: Path, limit: int) -> list[dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    features = payload.get("features", [])
    items: list[dict[str, object]] = []
    for feature in features:
        props = feature.get("properties", {})
        xid = str(props.get("id", "")).strip()
        scan_previews = props.get("scan_previews") or []
        if not isinstance(scan_previews, list):
            scan_previews = []
        if xid:
            items.append({"xid": xid, "scan_previews": scan_previews})
        if limit and len(items) >= limit:
            break
    return items


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


def count_existing_tiles(tiles_dir: Path) -> int:
    return sum(1 for _ in tiles_dir.glob("TileGroup*/*.jpg"))


def scan_tile_stats(tiles_dir: Path) -> dict[str, int | bool]:
    marker = scan_complete_marker(tiles_dir)
    marker_exists = marker.exists()
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

    tiles_expected = 0
    tiles_existing = 0
    tiles_missing = 0

    preview_expected = 0
    preview_present = 0
    preview_missing = 0

    for item in items:
        xid = str(item["xid"])
        previews = item.get("scan_previews") or []
        if not isinstance(previews, list) or not previews:
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
    print(f"Scans: complete={scan_complete} partial={scan_partial} missing={scan_missing} no_props={scan_no_props}")
    print(f"Tiles: expected={tiles_expected} existing={tiles_existing} missing={tiles_missing}")
    print(f"Previews: expected={preview_expected} present={preview_present} missing={preview_missing}")


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
                time.sleep(retry_sleep)
    raise last_exc if last_exc else RuntimeError("Download failed")


def write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def log_error(handle, payload: dict[str, object]) -> None:
    handle.write(json.dumps(payload, ensure_ascii=True) + "\n")


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
    if marker_path.exists() and not args.force:
        return 0
    scan_param = scan_index + 1 if scan_index >= 0 else 1
    permalink = f"{args.archive_base_url.rstrip('/')}/permalink?xid={xid}&scan={scan_param}"
    zoomify_html = dezoomify.resolve_zoomify(session, permalink)
    zoomify_img_path = dezoomify.extract_zoomify_img_path(zoomify_html)
    if not zoomify_img_path:
        raise ValueError("zoomifyImgPath not found")

    props_path = tiles_dir / "ImageProperties.xml"
    props = load_local_image_properties(props_path)
    if props is None or args.force:
        props = dezoomify.fetch_image_properties(session, zoomify_img_path)
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

    items = load_items(input_path, args.limit)
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

    output_dir.mkdir(parents=True, exist_ok=True)
    with error_path.open("a", encoding="utf-8") as error_handle:
        for item in items:
            xid = str(item["xid"])
            previews = item.get("scan_previews") or []
            if not isinstance(previews, list) or not previews:
                previews = [""]

            photo_downloaded = False
            photo_error = False
            photo_cached = True

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

                tiles_dir = tiles_root / xid / f"scan_{scan_index}"
                try:
                    downloaded_tiles = download_zoomify_tiles(
                        session, xid, scan_index, tiles_dir, args
                    )
                    if downloaded_tiles:
                        photo_downloaded = True
                except Exception as exc:
                    photo_error = True
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
                    tiles_cached = scan_complete_marker(tiles_dir).exists()
                    photo_cached = photo_cached and tiles_cached and (preview_cached or not preview_url)

            processed += 1
            if total:
                percent = (processed / total) * 100
                status = "downloaded" if photo_downloaded else "cached" if photo_cached else "partial"
                print(
                    f"Progress {processed}/{total} ({percent:.1f}%) xid={xid} [{status}] "
                    f"downloaded={downloaded} cached={skipped} errors={errors}"
                )
            if photo_error:
                errors += 1
            if photo_downloaded:
                downloaded += 1
            elif photo_cached:
                skipped += 1
            if args.sleep and photo_downloaded:
                time.sleep(args.sleep)


if __name__ == "__main__":
    main()
