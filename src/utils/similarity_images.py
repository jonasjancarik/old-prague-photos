import json
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image

import dezoomify
from src.utils.similarity_core import (
    HashResult,
    HashSourceError,
    LevelInfo,
    ScanInput,
)
from src.utils.similarity_hashing import hash_image_for_similarity


def normalize_base_url(value: str) -> str:
    return str(value or "").strip().rstrip("/")


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
    zoomify_img_path = normalize_base_url(zoomify_img_path)
    props = dezoomify.fetch_image_properties(session, zoomify_img_path)
    return zoomify_img_path, props["width"], props["height"], props["tile_size"]


def fetch_zoomify_properties(
    session: requests.Session,
    zoomify_img_path: str,
) -> tuple[int, int, int]:
    props = dezoomify.fetch_image_properties(session, zoomify_img_path)
    return props["width"], props["height"], props["tile_size"]


def levels_for_tiers(tiers: list[tuple[int, int]], tile_size: int) -> list[LevelInfo]:
    levels: list[LevelInfo] = []
    for level, (width, height) in enumerate(tiers):
        tiles_x, tiles_y = dezoomify.tiles_for((width, height), tile_size)
        tile_count = tiles_x * tiles_y
        levels.append(
            LevelInfo(
                level=level,
                width=width,
                height=height,
                tiles_x=tiles_x,
                tiles_y=tiles_y,
                tile_count=tile_count,
                long_side=max(width, height),
            )
        )
    return levels


def select_stitch_level(
    tiers: list[tuple[int, int]],
    tile_size: int,
    stitch_target_long_side: int,
    stitch_max_tiles: int,
) -> LevelInfo | None:
    levels = levels_for_tiers(tiers, tile_size)
    eligible = [level for level in levels if level.tile_count <= stitch_max_tiles]
    if not eligible:
        return None
    within_target = [
        level for level in eligible if level.long_side <= stitch_target_long_side
    ]
    if within_target:
        return max(within_target, key=lambda level: level.level)
    above_target = [
        level for level in eligible if level.long_side > stitch_target_long_side
    ]
    if not above_target:
        return max(eligible, key=lambda level: level.level)
    return min(
        above_target,
        key=lambda level: (
            level.long_side - stitch_target_long_side,
            -level.level,
        ),
    )


def build_level_fallback_chain(selected: LevelInfo, eligible: list[LevelInfo]) -> list[LevelInfo]:
    lower_levels = sorted(
        [level for level in eligible if level.level < selected.level],
        key=lambda level: level.level,
        reverse=True,
    )
    return [selected, *lower_levels]


def build_zoomify_tile_urls(
    zoomify_img_path: str,
    tiers: list[tuple[int, int]],
    tile_size: int,
    level: int,
) -> list[tuple[int, int, str]]:
    width, height = tiers[level]
    tiles_x, tiles_y = dezoomify.tiles_for((width, height), tile_size)
    requests_list: list[tuple[int, int, str]] = []
    for tile_y in range(tiles_y):
        for tile_x in range(tiles_x):
            group = dezoomify.tile_group_index(tiers, tile_size, level, tile_x, tile_y)
            tile_url = f"{zoomify_img_path}/TileGroup{group}/{level}-{tile_x}-{tile_y}.jpg"
            requests_list.append((tile_x, tile_y, tile_url))
    return requests_list


def stitch_zoomify_level(
    session: requests.Session,
    zoomify_img_path: str,
    tiers: list[tuple[int, int]],
    tile_size: int,
    level: int,
) -> Image.Image:
    width, height = tiers[level]
    image = Image.new("RGB", (width, height))
    for tile_x, tile_y, tile_url in build_zoomify_tile_urls(
        zoomify_img_path, tiers, tile_size, level
    ):
        response = session.get(tile_url, timeout=20)
        response.raise_for_status()
        with Image.open(BytesIO(response.content)) as tile_image:
            image.paste(tile_image.convert("RGB"), (tile_x * tile_size, tile_y * tile_size))
    return image


def fetch_single_tile_level0(
    session: requests.Session,
    zoomify_img_path: str,
    tiers: list[tuple[int, int]],
    tile_size: int,
) -> Image.Image:
    tile_requests = build_zoomify_tile_urls(zoomify_img_path, tiers, tile_size, 0)
    if not tile_requests:
        raise ValueError("No level-0 tiles available")
    _, _, tile_url = tile_requests[0]
    response = session.get(tile_url, timeout=20)
    response.raise_for_status()
    return Image.open(BytesIO(response.content))


def render_zoomify_image(
    session: requests.Session,
    zoomify_img_path: str,
    width: int,
    height: int,
    tile_size: int,
    stitch_target_long_side: int,
    stitch_max_tiles: int,
) -> tuple[Image.Image, str]:
    tiers = dezoomify.build_tiers(width, height, tile_size)
    levels = levels_for_tiers(tiers, tile_size)
    eligible = [level for level in levels if level.tile_count <= stitch_max_tiles]
    selected = select_stitch_level(
        tiers,
        tile_size,
        stitch_target_long_side,
        stitch_max_tiles,
    )
    stitch_errors: list[str] = []
    if selected is not None and eligible:
        for candidate in build_level_fallback_chain(selected, eligible):
            try:
                image = stitch_zoomify_level(
                    session,
                    zoomify_img_path,
                    tiers,
                    tile_size,
                    candidate.level,
                )
                return image, f"stitched_level_{candidate.level}"
            except Exception as exc:
                stitch_errors.append(f"level {candidate.level}: {exc}")
    try:
        return (
            fetch_single_tile_level0(session, zoomify_img_path, tiers, tile_size),
            "single_tile_level0",
        )
    except Exception as exc:
        if stitch_errors:
            details = "; ".join(stitch_errors)
            raise ValueError(f"Stitch failed ({details}); single tile failed: {exc}")
        raise


def compute_preview_hash(
    session: requests.Session,
    preview_url: str,
    hash_size: int,
    local_path: Path | None = None,
    image_source: str = "preview",
) -> HashResult:
    if local_path and local_path.exists():
        with Image.open(local_path) as image:
            width, height = image.size
            return HashResult(
                hash_value=hash_image_for_similarity(image, hash_size),
                image_source=image_source,
                render_mode="preview_original",
                image_width=width,
                image_height=height,
            )
    response = session.get(preview_url, timeout=20)
    response.raise_for_status()
    with Image.open(BytesIO(response.content)) as image:
        width, height = image.size
        return HashResult(
            hash_value=hash_image_for_similarity(image, hash_size),
            image_source=image_source,
            render_mode="preview_original",
            image_width=width,
            image_height=height,
        )


def build_zoomify_candidates(
    xid: str,
    scan_index: int,
    r2_tiles_base: str,
    feature_zoomify_path: str,
) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []
    if r2_tiles_base:
        candidates.append(
            ("r2_zoomify", f"{r2_tiles_base}/{xid}/scan_{scan_index}")
        )
    if feature_zoomify_path:
        candidates.append(("feature_zoomify", normalize_base_url(feature_zoomify_path)))
    deduped: list[tuple[str, str]] = []
    seen: set[str] = set()
    for source, path in candidates:
        normalized = normalize_base_url(path)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append((source, normalized))
    return deduped


def find_local_preview_path(download_root: Path, xid: str, scan_index: int) -> Path | None:
    previews_dir = download_root / "previews" / xid
    if not previews_dir.exists():
        return None
    candidates = sorted(previews_dir.glob(f"scan_{scan_index}.*"))
    return candidates[0] if candidates else None


def stitched_cache_paths(
    stitched_root: Path, xid: str, scan_index: int
) -> tuple[Path, Path]:
    scan_dir = stitched_root / xid
    image_path = scan_dir / f"scan_{scan_index}.jpg"
    meta_path = scan_dir / f"scan_{scan_index}.meta.json"
    return image_path, meta_path


def load_local_stitched_hash(
    image_path: Path,
    meta_path: Path,
    hash_size: int,
) -> HashResult | None:
    if not image_path.exists():
        return None
    render_mode = "stitched_level_0"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            render_mode = str(meta.get("render_mode") or render_mode).strip() or render_mode
        except Exception:
            render_mode = "stitched_level_0"
    with Image.open(image_path) as image:
        width, height = image.size
        return HashResult(
            hash_value=hash_image_for_similarity(image, hash_size),
            image_source="local_stitched",
            render_mode=render_mode,
            image_width=width,
            image_height=height,
        )


def persist_stitched_cache(
    image: Image.Image,
    image_path: Path,
    meta_path: Path,
    render_mode: str,
    source: str,
) -> None:
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(image_path, format="JPEG", quality=90)
    meta = {
        "render_mode": render_mode,
        "source": source,
        "image_width": image.size[0],
        "image_height": image.size[1],
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=True), encoding="utf-8")


def compute_zoomify_hash(
    session: requests.Session,
    zoomify_img_path: str,
    image_source: str,
    hash_size: int,
    stitch_target_long_side: int,
    stitch_max_tiles: int,
    stitched_image_path: Path,
    stitched_meta_path: Path,
) -> HashResult:
    width, height, tile_size = fetch_zoomify_properties(session, zoomify_img_path)
    image, render_mode = render_zoomify_image(
        session,
        zoomify_img_path,
        width,
        height,
        tile_size,
        stitch_target_long_side=stitch_target_long_side,
        stitch_max_tiles=stitch_max_tiles,
    )
    with image:
        image_width, image_height = image.size
        hash_value = hash_image_for_similarity(image, hash_size)
        persist_stitched_cache(
            image=image,
            image_path=stitched_image_path,
            meta_path=stitched_meta_path,
            render_mode=render_mode,
            source=image_source,
        )
    return HashResult(
        hash_value=hash_value,
        image_source=image_source,
        render_mode=render_mode,
        image_width=image_width,
        image_height=image_height,
    )


def compute_hash_for_scan(
    session: requests.Session,
    xid: str,
    scan: ScanInput,
    archive_base_url: str,
    r2_tiles_base: str,
    hash_size: int,
    stitch_target_long_side: int,
    stitch_max_tiles: int,
    download_root: Path,
    stitched_root: Path,
    no_download_cache: bool,
) -> HashResult:
    source_attempts: list[dict[str, str]] = []
    stitched_image_path, stitched_meta_path = stitched_cache_paths(
        stitched_root,
        xid,
        scan.scan_index,
    )
    local_stitched = load_local_stitched_hash(
        stitched_image_path,
        stitched_meta_path,
        hash_size,
    )
    if local_stitched is not None:
        return local_stitched

    zoomify_candidates = build_zoomify_candidates(
        xid=xid,
        scan_index=scan.scan_index,
        r2_tiles_base=r2_tiles_base,
        feature_zoomify_path=scan.feature_zoomify_path,
    )
    for source, zoomify_img_path in zoomify_candidates:
        try:
            return compute_zoomify_hash(
                session=session,
                zoomify_img_path=zoomify_img_path,
                image_source=source,
                hash_size=hash_size,
                stitch_target_long_side=stitch_target_long_side,
                stitch_max_tiles=stitch_max_tiles,
                stitched_image_path=stitched_image_path,
                stitched_meta_path=stitched_meta_path,
            )
        except Exception as exc:
            source_attempts.append(
                {
                    "source": source,
                    "path": zoomify_img_path,
                    "error": str(exc),
                }
            )

    try:
        archive_zoomify_img_path, _, _, _ = fetch_zoomify_meta(
            session,
            xid,
            archive_base_url,
            scan.scan_index,
        )
        return compute_zoomify_hash(
            session=session,
            zoomify_img_path=archive_zoomify_img_path,
            image_source="archive_zoomify",
            hash_size=hash_size,
            stitch_target_long_side=stitch_target_long_side,
            stitch_max_tiles=stitch_max_tiles,
            stitched_image_path=stitched_image_path,
            stitched_meta_path=stitched_meta_path,
        )
    except Exception as exc:
        source_attempts.append(
            {
                "source": "archive_zoomify",
                "path": "",
                "error": str(exc),
            }
        )

    local_preview_path = None
    if not no_download_cache:
        local_preview_path = find_local_preview_path(download_root, xid, scan.scan_index)
    if local_preview_path:
        try:
            return compute_preview_hash(
                session,
                preview_url="",
                hash_size=hash_size,
                local_path=local_preview_path,
                image_source="local_preview",
            )
        except Exception as exc:
            source_attempts.append(
                {
                    "source": "local_preview",
                    "path": str(local_preview_path),
                    "error": str(exc),
                }
            )

    if scan.preview_url:
        try:
            return compute_preview_hash(
                session,
                preview_url=scan.preview_url,
                hash_size=hash_size,
                local_path=None,
                image_source="preview",
            )
        except Exception as exc:
            source_attempts.append(
                {
                    "source": "preview",
                    "path": scan.preview_url,
                    "error": str(exc),
                }
            )

    raise HashSourceError("No image source succeeded", source_attempts)
