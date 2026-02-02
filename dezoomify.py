import argparse
import html
import math
import os
import time
import re
import random
from urllib.parse import urljoin, urlparse, parse_qs

import requests
from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download and stitch Zoomify tiles")
    parser.add_argument("url", help="Permalink or Zoomify.action URL")
    parser.add_argument("--output", default="final_image.jpg", help="Output image")
    parser.add_argument(
        "--tiles-dir", default="zoomify_tiles", help="Directory for tile cache"
    )
    return parser.parse_args()


def extract_zoomify_url(page_html: str, base_url: str) -> str | None:
    match = re.search(r'Zoomify\.action[^"\']+', page_html)
    if not match:
        return None
    return urljoin(base_url, html.unescape(match.group(0)))


def extract_zoomify_img_path(page_html: str) -> str | None:
    match = re.search(r'zoomifyImgPath\s*=\s*"([^"]+)"', page_html)
    return match.group(1) if match else None


def fetch_with_retry(
    session: requests.Session,
    url: str,
    timeout: float,
    retries: int,
    retry_sleep: float,
) -> requests.Response:
    last_exc = None
    for attempt in range(retries + 1):
        try:
            response = session.get(url, timeout=timeout)
            response.raise_for_status()
            return response
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
    raise last_exc if last_exc else RuntimeError("Request failed")


def fetch_zoomify_page(
    session: requests.Session,
    url: str,
    timeout: float = 20,
    retries: int = 0,
    retry_sleep: float = 1.0,
) -> str:
    response = fetch_with_retry(session, url, timeout, retries, retry_sleep)
    return response.text


def resolve_zoomify(
    session: requests.Session,
    url: str,
    timeout: float = 20,
    retries: int = 0,
    retry_sleep: float = 1.0,
) -> str:
    cleaned_url = url.replace("\\", "").split("#", maxsplit=1)[0]

    page_html = None
    try:
        page_html = fetch_zoomify_page(session, cleaned_url, timeout, retries, retry_sleep)
    except requests.RequestException:
        page_html = None

    if page_html:
        if extract_zoomify_img_path(page_html):
            return page_html

        zoomify_url = extract_zoomify_url(page_html, cleaned_url)
        if zoomify_url:
            zoomify_html = fetch_zoomify_page(session, zoomify_url, timeout, retries, retry_sleep)
            if extract_zoomify_img_path(zoomify_html):
                return zoomify_html

    parsed = urlparse(cleaned_url)
    xid = parse_qs(parsed.query).get("xid", [None])[0]
    if xid:
        permalink = f"{parsed.scheme}://{parsed.netloc}/pragapublica/permalink?xid={xid}"
        permalink_html = fetch_zoomify_page(session, permalink, timeout, retries, retry_sleep)
        zoomify_url = extract_zoomify_url(permalink_html, permalink)
        if zoomify_url:
            zoomify_html = fetch_zoomify_page(session, zoomify_url, timeout, retries, retry_sleep)
            if extract_zoomify_img_path(zoomify_html):
                return zoomify_html

    raise ValueError("Failed to resolve Zoomify image")


def fetch_image_properties(
    session: requests.Session,
    base_url: str,
    timeout: float = 20,
    retries: int = 0,
    retry_sleep: float = 1.0,
) -> dict[str, int]:
    props_url = f"{base_url}/ImageProperties.xml"
    response = fetch_with_retry(session, props_url, timeout, retries, retry_sleep)
    text = response.text

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


def build_tiers(width: int, height: int, tile_size: int) -> list[tuple[int, int]]:
    tiers = []
    w, h = width, height
    while w > tile_size or h > tile_size:
        tiers.append((w, h))
        w = (w + 1) // 2
        h = (h + 1) // 2
    tiers.append((w, h))
    return list(reversed(tiers))


def tiles_for(size: tuple[int, int], tile_size: int) -> tuple[int, int]:
    w, h = size
    return (math.ceil(w / tile_size), math.ceil(h / tile_size))


def tile_group_index(
    tiers: list[tuple[int, int]], tile_size: int, z: int, x: int, y: int
) -> int:
    offset = 0
    for tier in tiers[:z]:
        tiles_x, tiles_y = tiles_for(tier, tile_size)
        offset += tiles_x * tiles_y

    tiles_x, _ = tiles_for(tiers[z], tile_size)
    return (offset + y * tiles_x + x) // 256


def main() -> None:
    args = parse_args()
    session = requests.Session()

    zoomify_html = resolve_zoomify(session, args.url)
    zoomify_img_path = extract_zoomify_img_path(zoomify_html)
    if not zoomify_img_path:
        raise ValueError("Failed to extract zoomifyImgPath")

    props = fetch_image_properties(session, zoomify_img_path)
    image_width = props["width"]
    image_height = props["height"]
    tile_size = props["tile_size"]

    tiles_dir = args.tiles_dir
    os.makedirs(tiles_dir, exist_ok=True)

    tiers = build_tiers(image_width, image_height, tile_size)
    max_zoom = len(tiers) - 1
    tiles_x, tiles_y = tiles_for(tiers[max_zoom], tile_size)

    for tile_y in range(tiles_y):
        for tile_x in range(tiles_x):
            group = tile_group_index(tiers, tile_size, max_zoom, tile_x, tile_y)
            tile_url = (
                f"{zoomify_img_path}/TileGroup{group}/{max_zoom}-{tile_x}-{tile_y}.jpg"
            )
            tile_path = os.path.join(tiles_dir, f"tile_{tile_x}_{tile_y}.jpg")
            if os.path.exists(tile_path):
                continue

            tile_response = session.get(tile_url, timeout=20)
            if tile_response.status_code == 200:
                with open(tile_path, "wb") as tile_file:
                    tile_file.write(tile_response.content)
                print(f"Downloaded {tile_url}")
            else:
                print(f"Failed to download {tile_url}")

    final_image = Image.new("RGB", (image_width, image_height))
    for tile_y in range(tiles_y):
        for tile_x in range(tiles_x):
            tile_path = os.path.join(tiles_dir, f"tile_{tile_x}_{tile_y}.jpg")
            if os.path.exists(tile_path):
                tile_image = Image.open(tile_path)
                final_image.paste(tile_image, (tile_x * tile_size, tile_y * tile_size))

    final_image.save(args.output)
    print(f"Final image saved as '{args.output}'")


if __name__ == "__main__":
    main()
