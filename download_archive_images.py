import argparse
import json
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
    args: argparse.Namespace,
) -> bool:
    if target_path.exists() and not args.force:
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
    scan_param = scan_index + 1 if scan_index >= 0 else 1
    permalink = f"{args.archive_base_url.rstrip('/')}/permalink?xid={xid}&scan={scan_param}"
    zoomify_html = dezoomify.resolve_zoomify(session, permalink)
    zoomify_img_path = dezoomify.extract_zoomify_img_path(zoomify_html)
    if not zoomify_img_path:
        raise ValueError("zoomifyImgPath not found")

    props = dezoomify.fetch_image_properties(session, zoomify_img_path)
    props_path = tiles_dir / "ImageProperties.xml"
    if not props_path.exists() or args.force:
        props_xml = fetch_bytes(
            session,
            f"{zoomify_img_path}/ImageProperties.xml",
            args.timeout,
            args.retries,
            args.retry_sleep,
        )
        write_bytes(props_path, props_xml)

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

    session = requests.Session()
    session.headers.update({"User-Agent": "old-prague-photos/archive-download"})

    total = len(items)
    processed = 0

    output_dir.mkdir(parents=True, exist_ok=True)
    with error_path.open("a", encoding="utf-8") as error_handle:
        for item in items:
            xid = str(item["xid"])
            previews = item.get("scan_previews") or []
            if not isinstance(previews, list) or not previews:
                previews = [""]

            for scan_index, preview_url in enumerate(previews):
                preview_url = str(preview_url or "").strip()
                if preview_url:
                    preview_ext = url_extension(preview_url)
                    preview_path = previews_dir / xid / f"scan_{scan_index}{preview_ext}"
                    try:
                        download_preview(session, preview_url, preview_path, args)
                    except Exception as exc:
                        log_error(
                            error_handle,
                            {
                                "xid": xid,
                                "scan_index": scan_index,
                                "preview_url": preview_url,
                                "error": str(exc),
                            },
                        )

                tiles_dir = tiles_root / xid / f"scan_{scan_index}"
                try:
                    download_zoomify_tiles(session, xid, scan_index, tiles_dir, args)
                except Exception as exc:
                    log_error(
                        error_handle,
                        {
                            "xid": xid,
                            "scan_index": scan_index,
                            "permalink_scan": scan_index + 1,
                            "error": str(exc),
                        },
                    )

            processed += 1
            if total:
                percent = (processed / total) * 100
                print(f"Progress {processed}/{total} ({percent:.1f}%) xid={xid}")
            if args.sleep:
                time.sleep(args.sleep)


if __name__ == "__main__":
    main()
