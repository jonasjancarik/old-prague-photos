import json
import os
import re
import html
import time
import hmac
import hashlib
from urllib.parse import urljoin
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Load .env for local development
load_dotenv()

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
STATIC_DIR = ROOT / "static"
STATIC_DATA_DIR = STATIC_DIR / "data"
DATA_DIR = ROOT / "data"
PHOTOS_PATH = STATIC_DATA_DIR / "photos.geojson"
FEEDBACK_PATH = DATA_DIR / "feedback.jsonl"
CORRECTIONS_PATH = DATA_DIR / "corrections.jsonl"
MERGES_PATH = DATA_DIR / "merges.jsonl"
LOCAL_PREVIEWS_DIR = PROJECT_ROOT / "downloads" / "archive" / "previews"

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
R2_PROBE_TIMEOUT_S = 5.0
R2_PROBE_RETRIES = 1

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
XID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
SQLITE_DATETIME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$"
)
SESSION_COOKIE_NAME = "opp_turnstile_session"
SESSION_TTL_SECONDS = 6 * 60 * 60

app = FastAPI(title="Prohlížeč historických fotografií Prahy")

_photos_cache: dict[str, Any] | None = None
_photos_cache_mtime: float | None = None
_feedback_lock = Lock()
_zoomify_cache: dict[str, dict[str, Any]] = {}
_preview_url_cache: dict[str, dict[str, Any]] = {}
_xid_group_cache: dict[str, str] | None = None
_feature_preview_cache: dict[str, str] | None = None


class FeedbackPayload(BaseModel):
    xid: str = Field(min_length=1)
    issue: str = Field(min_length=1, max_length=40)
    message: str = Field(min_length=5, max_length=2000)
    email: str | None = None
    token: str | None = None


class CorrectionPayload(BaseModel):
    xid: str = Field(min_length=1)
    group_id: str | None = None
    lat: float | None = None
    lon: float | None = None
    verdict: str | None = None
    message: str | None = Field(default=None, max_length=2000)
    email: str | None = None
    token: str | None = None


class VerifyPayload(BaseModel):
    token: str | None = None


class MergePayload(BaseModel):
    group_id_a: str = Field(min_length=1)
    group_id_b: str = Field(min_length=1)
    verdict: str | None = None
    token: str | None = None


def is_turnstile_bypass() -> bool:
    value = os.environ.get("TURNSTILE_BYPASS", "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def load_photos() -> dict[str, Any]:
    global _photos_cache, _photos_cache_mtime, _xid_group_cache, _feature_preview_cache, _preview_url_cache
    if not PHOTOS_PATH.exists():
        raise HTTPException(
            status_code=500,
            detail="Chybí GeoJSON. Spusťte viewer/build_geojson.py",
        )
    mtime = PHOTOS_PATH.stat().st_mtime
    if _photos_cache is None or _photos_cache_mtime != mtime:
        with PHOTOS_PATH.open(encoding="utf-8") as handle:
            _photos_cache = json.load(handle)
        _photos_cache_mtime = mtime
        _xid_group_cache = None
        _feature_preview_cache = None
        _preview_url_cache = {}
    return _photos_cache


def build_xid_group_cache() -> dict[str, str]:
    global _xid_group_cache
    if _xid_group_cache is None:
        mapping: dict[str, str] = {}
        try:
            photos = load_photos()
        except HTTPException:
            photos = {}
        for feature in photos.get("features", []):
            props = feature.get("properties") or {}
            xid = str(props.get("id") or "").strip()
            group_id = str(props.get("group_id") or "").strip()
            if xid and group_id:
                mapping[xid] = group_id
        _xid_group_cache = mapping
    return _xid_group_cache


def _normalize_id(value: Any) -> str:
    return str(value or "").strip()


def _parse_event_time(value: Any) -> float:
    raw = _normalize_id(value)
    if not raw:
        return 0.0

    iso_value = raw
    if SQLITE_DATETIME_PATTERN.fullmatch(raw):
        iso_value = raw.replace(" ", "T") + "Z"
    elif raw.endswith("Z"):
        iso_value = raw[:-1] + "+00:00"

    try:
        parsed = datetime.fromisoformat(iso_value)
    except ValueError:
        return 0.0

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _event_order_key(record: dict[str, Any]) -> tuple[float, float, str, int]:
    ts = _parse_event_time(record.get("received_at") or record.get("created_at"))
    raw_id = _normalize_id(record.get("id"))
    try:
        numeric_id = float(raw_id)
    except ValueError:
        numeric_id = float("-inf")
    seq = int(record.get("_seq") or 0)
    return (ts, numeric_id, raw_id, seq)


def _is_newer_event(candidate: dict[str, Any], current: dict[str, Any]) -> bool:
    return _event_order_key(candidate) > _event_order_key(current)


def _to_finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in {float("inf"), float("-inf")}:
        return None
    return number


def _create_union_find(ids: set[str]) -> tuple[dict[str, str], Any, Any]:
    parent = {item: item for item in ids if item}

    def find(item: str) -> str:
        if not item:
            return ""
        if item not in parent:
            parent[item] = item
            return item
        root = item
        while parent[root] != root:
            root = parent[root]
        while parent[item] != item:
            next_item = parent[item]
            parent[item] = root
            item = next_item
        return root

    def union(a: str, b: str) -> None:
        if not a or not b:
            return
        root_a = find(a)
        root_b = find(b)
        if not root_a or not root_b or root_a == root_b:
            return
        winner, loser = sorted([root_a, root_b])
        parent[loser] = winner

    return parent, find, union


def _load_correction_records() -> list[dict[str, Any]]:
    if not CORRECTIONS_PATH.exists():
        return []

    rows: list[dict[str, Any]] = []
    with CORRECTIONS_PATH.open(encoding="utf-8") as handle:
        for seq, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            xid = _normalize_id(record.get("xid"))
            if not xid:
                continue
            rows.append(
                {
                    **record,
                    "xid": xid,
                    "_seq": seq,
                }
            )
    return rows


def _load_latest_merge_records() -> list[dict[str, Any]]:
    if not MERGES_PATH.exists():
        return []

    latest: dict[str, dict[str, Any]] = {}
    with MERGES_PATH.open(encoding="utf-8") as handle:
        for seq, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            group_id_a = _normalize_id(record.get("group_id_a"))
            group_id_b = _normalize_id(record.get("group_id_b"))
            verdict = _normalize_id(record.get("verdict")).lower()
            if not group_id_a or not group_id_b or group_id_a == group_id_b:
                continue
            if verdict not in {"same", "different"}:
                continue
            if group_id_a > group_id_b:
                group_id_a, group_id_b = group_id_b, group_id_a

            pair_key = f"{group_id_a}::{group_id_b}"
            candidate = {
                "id": record.get("id") or f"merge_{seq}",
                "group_id_a": group_id_a,
                "group_id_b": group_id_b,
                "verdict": verdict,
                "received_at": record.get("received_at"),
                "created_at": record.get("received_at"),
                "_seq": seq,
            }
            current = latest.get(pair_key)
            if current is None or _is_newer_event(candidate, current):
                latest[pair_key] = candidate

    return [latest[key] for key in sorted(latest)]


def build_review_state() -> dict[str, Any]:
    xid_group = build_xid_group_cache()
    correction_rows = _load_correction_records()
    merge_rows = _load_latest_merge_records()

    known_group_ids = set(xid_group.values())
    normalized_corrections: list[dict[str, Any]] = []
    for record in correction_rows:
        xid = _normalize_id(record.get("xid"))
        if not xid:
            continue
        mapped_group = xid_group.get(xid, "")
        stored_group = _normalize_id(record.get("group_id"))
        base_group = mapped_group or stored_group or xid
        if not base_group:
            continue

        lat = _to_finite_float(record.get("lat"))
        lon = _to_finite_float(record.get("lon"))
        has_coordinates = bool(record.get("has_coordinates")) and lat is not None and lon is not None

        normalized = {
            "id": record.get("id") or f"corr_{record.get('_seq', 0)}",
            "xid": xid,
            "base_group_id": base_group,
            "verdict": _normalize_id(record.get("verdict")).lower(),
            "received_at": record.get("received_at"),
            "created_at": record.get("received_at"),
            "has_coordinates": has_coordinates,
            "lat": lat,
            "lon": lon,
            "_seq": int(record.get("_seq") or 0),
        }
        normalized_corrections.append(normalized)
        known_group_ids.add(base_group)

    for merge in merge_rows:
        known_group_ids.add(merge["group_id_a"])
        known_group_ids.add(merge["group_id_b"])

    _parent, find, union = _create_union_find(known_group_ids)
    for merge in merge_rows:
        if merge["verdict"] == "same":
            union(merge["group_id_a"], merge["group_id_b"])

    resolved_group_by_xid: dict[str, str] = {}
    for xid, group_id in xid_group.items():
        resolved_group_by_xid[xid] = find(group_id) or group_id

    group_roots: dict[str, str] = {}
    for group_id in sorted(known_group_ids):
        if group_id:
            group_roots[group_id] = find(group_id) or group_id

    latest_any_by_group: dict[str, dict[str, Any]] = {}
    latest_coords_by_group: dict[str, dict[str, Any]] = {}
    for record in normalized_corrections:
        resolved_group = find(record["base_group_id"]) or record["base_group_id"]
        if not resolved_group:
            continue

        current_any = latest_any_by_group.get(resolved_group)
        if current_any is None or _is_newer_event(record, current_any):
            latest_any_by_group[resolved_group] = record

        if record["has_coordinates"]:
            current_coords = latest_coords_by_group.get(resolved_group)
            if current_coords is None or _is_newer_event(record, current_coords):
                latest_coords_by_group[resolved_group] = record

    group_corrections: list[dict[str, Any]] = []
    for group_id in sorted(latest_any_by_group):
        latest_any = latest_any_by_group[group_id]
        latest_coords = latest_coords_by_group.get(group_id)
        group_corrections.append(
            {
                "xid": latest_any["xid"],
                "group_id": group_id,
                "verdict": latest_any["verdict"] or None,
                "received_at": latest_any.get("received_at"),
                "has_coordinates": bool(latest_coords),
                "lat": latest_coords.get("lat") if latest_coords else None,
                "lon": latest_coords.get("lon") if latest_coords else None,
            }
        )

    done_group_ids = sorted(
        item["group_id"]
        for item in group_corrections
        if item.get("has_coordinates") or item.get("verdict") == "ok"
    )

    merge_decisions = [
        {
            "group_id_a": row["group_id_a"],
            "group_id_b": row["group_id_b"],
            "verdict": row["verdict"],
            "received_at": row.get("received_at"),
        }
        for row in merge_rows
    ]

    return {
        "groupCorrections": group_corrections,
        "doneGroupIds": done_group_ids,
        "resolvedGroupByXid": resolved_group_by_xid,
        "groupRoots": group_roots,
        "mergeDecisions": merge_decisions,
    }


def is_valid_email(email: str) -> bool:
    return bool(EMAIL_PATTERN.match(email))


def _session_secret() -> str:
    return (
        os.environ.get("TURNSTILE_SESSION_SECRET", "").strip()
        or os.environ.get("TURNSTILE_SECRET_KEY", "").strip()
    )


def _sign_session(exp: int) -> str:
    secret = _session_secret()
    if not secret and is_turnstile_bypass():
        secret = "dev-bypass"
    if not secret:
        raise HTTPException(status_code=500, detail="Chybí session secret")
    payload = str(exp).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def _has_valid_session(request: Request) -> bool:
    raw = request.cookies.get(SESSION_COOKIE_NAME)
    if not raw:
        return False
    parts = raw.split(".", 1)
    if len(parts) != 2:
        return False
    exp_str, sig = parts
    if not exp_str.isdigit():
        return False
    exp = int(exp_str)
    if exp < int(time.time()):
        return False
    try:
        expected = _sign_session(exp)
    except HTTPException:
        return False
    return hmac.compare_digest(expected, sig)


def verify_turnstile(token: str, remoteip: str | None) -> None:
    if is_turnstile_bypass():
        return

    secret = os.environ.get("TURNSTILE_SECRET_KEY", "").strip()
    if not secret:
        raise HTTPException(status_code=500, detail="Turnstile není nastaven")

    data = {"secret": secret, "response": token}
    if remoteip:
        data["remoteip"] = remoteip

    try:
        response = requests.post(TURNSTILE_VERIFY_URL, data=data, timeout=8)
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail="Ověření Turnstile selhalo"
        ) from exc

    if not payload.get("success"):
        raise HTTPException(status_code=400, detail="Ověření Turnstile selhalo")


def _fetch_text(session: requests.Session, url: str) -> str:
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            response = session.get(url, timeout=20)
            response.raise_for_status()
            return response.text
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
                continue
            raise
    raise last_exc or RuntimeError("Fetch failed")


def _extract_zoomify_url(permalink_html: str, permalink_url: str) -> str | None:
    match = re.search(r"Zoomify\.action[^\"']+", permalink_html, re.IGNORECASE)
    if not match:
        return None
    rel = html.unescape(match.group(0))
    return urljoin(permalink_url, rel)


def _extract_zoomify_img_path(zoomify_html: str) -> str | None:
    match = re.search(r'zoomifyImgPath\s*=\s*"([^"]+)"', zoomify_html)
    return match.group(1) if match else None


def _parse_image_properties(props_xml: str) -> dict[str, int | None]:
    def find_int(attr: str) -> int | None:
        match = re.search(rf'{attr}="(\d+)"', props_xml, re.IGNORECASE)
        return int(match.group(1)) if match else None

    return {
        "width": find_int("WIDTH"),
        "height": find_int("HEIGHT"),
        "tileSize": find_int("TILESIZE"),
    }


def _get_r2_zoomify_base() -> str:
    return os.environ.get("R2_TILES_BASE", "").strip().rstrip("/")


def _resolve_r2_zoomify(
    session: requests.Session, xid: str, scan_index: int
) -> dict[str, Any] | None:
    base = _get_r2_zoomify_base()
    if not base:
        return None
    zoomify_img_path = f"{base}/{xid}/scan_{scan_index}"
    props_url = f"{zoomify_img_path}/ImageProperties.xml"
    try:
        props_xml = _fetch_text(session, props_url)
    except requests.RequestException:
        return None
    props = _parse_image_properties(props_xml)
    if not props.get("width") or not props.get("height") or not props.get("tileSize"):
        return None
    return {
        "xid": xid,
        "zoomifyImgPath": zoomify_img_path,
        "imagePropertiesUrl": props_url,
        **props,
        "source": "r2",
    }


def _sanitize_xid(raw_xid: str) -> str:
    xid = raw_xid.strip()
    if not xid:
        raise HTTPException(status_code=400, detail="Chybí xid")
    if len(xid) > 200 or not XID_PATTERN.fullmatch(xid):
        raise HTTPException(status_code=400, detail="Neplatný xid")
    return xid


def _r2_preview_url(xid: str, scan_index: int = 0) -> str:
    base = _get_r2_zoomify_base()
    if not base:
        return ""
    return f"{base}/{xid}/scan_{scan_index}/TileGroup0/0-0-0.jpg"


def _url_exists(
    session: requests.Session,
    url: str,
    *,
    timeout: float = R2_PROBE_TIMEOUT_S,
    retries: int = R2_PROBE_RETRIES,
) -> bool:
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            head = session.head(url, timeout=timeout, allow_redirects=True)
            if 200 <= head.status_code < 300:
                return True
        except requests.RequestException as exc:
            last_exc = exc
        try:
            # Some public object stores do not handle HEAD consistently.
            get = session.get(
                url,
                timeout=timeout,
                allow_redirects=True,
                stream=True,
                headers={"Range": "bytes=0-0"},
            )
            try:
                return 200 <= get.status_code < 300
            finally:
                get.close()
        except requests.RequestException as exc:
            last_exc = exc
        if attempt < retries:
            time.sleep(0.25 * (attempt + 1))
    if last_exc:
        return False
    return False


def _find_local_preview_file(xid: str, scan_index: int = 0) -> Path | None:
    preview_dir = LOCAL_PREVIEWS_DIR / xid
    if not preview_dir.exists():
        return None
    candidates = sorted(preview_dir.glob(f"scan_{scan_index}.*"))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _get_feature_preview_map() -> dict[str, str]:
    global _feature_preview_cache
    if _feature_preview_cache is not None:
        return _feature_preview_cache
    mapping: dict[str, str] = {}
    photos = load_photos()
    for feature in photos.get("features", []):
        props = feature.get("properties") or {}
        xid = str(props.get("id") or "").strip()
        if not xid:
            continue
        previews = props.get("scan_previews")
        if isinstance(previews, list) and previews:
            first = str(previews[0] or "").strip()
            if first:
                mapping[xid] = first
    _feature_preview_cache = mapping
    return mapping


def _get_feature_preview_url(xid: str) -> str:
    return _get_feature_preview_map().get(xid, "")


def normalize_corrections() -> list[dict[str, Any]]:
    return build_review_state()["groupCorrections"]


@app.get("/api/config")
def get_config() -> JSONResponse:
    photos = load_photos()
    archive_base_url = os.environ.get(
        "ARCHIVE_BASE_URL", "https://katalog.ahmp.cz/pragapublica"
    ).rstrip("/")
    return JSONResponse(
        {
            "turnstileSiteKey": os.environ.get("TURNSTILE_SITE_KEY", ""),
            "turnstileBypass": is_turnstile_bypass(),
            "archiveBaseUrl": archive_base_url,
            "totalPhotos": len(photos.get("features", [])),
        }
    )


@app.get("/api/photos")
def get_photos() -> JSONResponse:
    return JSONResponse(load_photos())


@app.post("/api/verify")
def verify_session(payload: VerifyPayload, request: Request) -> JSONResponse:
    if not is_turnstile_bypass():
        if payload.token:
            verify_turnstile(
                payload.token, request.client.host if request.client else None
            )
        elif not _has_valid_session(request):
            raise HTTPException(status_code=400, detail="Turnstile je povinný")

    exp = int(time.time()) + SESSION_TTL_SECONDS
    value = f"{exp}.{_sign_session(exp)}"
    response = JSONResponse({"ok": True})
    response.set_cookie(
        SESSION_COOKIE_NAME,
        value,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
    )
    return response


@app.get("/api/preview-local")
def get_preview_local(xid: str, scanIndex: int = 0) -> FileResponse:
    xid = _sanitize_xid(xid)
    if scanIndex < 0 or scanIndex > 1000:
        raise HTTPException(status_code=400, detail="Neplatný scanIndex")
    local_path = _find_local_preview_file(xid, scanIndex)
    if not local_path:
        raise HTTPException(status_code=404, detail="Náhled nenalezen")
    base = LOCAL_PREVIEWS_DIR.resolve()
    resolved = local_path.resolve()
    if base not in resolved.parents:
        raise HTTPException(status_code=404, detail="Náhled nenalezen")
    return FileResponse(resolved)


@app.get("/api/preview-url")
def get_preview_url(xid: str) -> JSONResponse:
    xid = _sanitize_xid(xid)
    # Trigger photo cache refresh so preview caches reset on photos.geojson updates.
    load_photos()
    cached = _preview_url_cache.get(xid)
    if cached:
        return JSONResponse(cached)

    payload: dict[str, Any] = {
        "xid": xid,
        "url": "",
        "source": "none",
        "scan_index": 0,
    }

    r2_url = _r2_preview_url(xid, 0)
    if r2_url:
        with requests.Session() as session:
            session.headers.update({"User-Agent": "old-prague-photos/preview-probe"})
            if _url_exists(session, r2_url):
                payload.update({"url": r2_url, "source": "r2"})
                _preview_url_cache[xid] = payload
                return JSONResponse(payload)

    local_preview = _find_local_preview_file(xid, 0)
    if local_preview:
        payload.update(
            {
                "url": f"/api/preview-local?xid={xid}&scanIndex=0",
                "source": "local_cache",
            }
        )
        _preview_url_cache[xid] = payload
        return JSONResponse(payload)

    feature_preview = _get_feature_preview_url(xid)
    if feature_preview:
        payload.update({"url": feature_preview, "source": "feature_preview"})

    _preview_url_cache[xid] = payload
    return JSONResponse(payload)


@app.get("/api/zoomify")
def get_zoomify(xid: str) -> JSONResponse:
    xid = xid.strip()
    if not xid:
        raise HTTPException(status_code=400, detail="Chybí xid")

    cached = _zoomify_cache.get(xid)
    if cached:
        return JSONResponse(cached)

    archive_base_url = os.environ.get(
        "ARCHIVE_BASE_URL", "https://katalog.ahmp.cz/pragapublica"
    ).rstrip("/")
    permalink_url = f"{archive_base_url}/permalink?xid={xid}&scan=1"

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "old-prague-photos/zoomify",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
    )
    try:
        r2_payload = _resolve_r2_zoomify(session, xid, 0)
        if r2_payload:
            _zoomify_cache[xid] = r2_payload
            return JSONResponse(r2_payload)

        permalink_html = _fetch_text(session, permalink_url)
        zoomify_url = _extract_zoomify_url(permalink_html, permalink_url)
        if not zoomify_url:
            raise HTTPException(status_code=502, detail="Zoomify odkaz nenalezen")

        zoomify_html = _fetch_text(session, zoomify_url)
        zoomify_img_path = _extract_zoomify_img_path(zoomify_html)
        if not zoomify_img_path:
            raise HTTPException(status_code=502, detail="zoomifyImgPath nenalezen")

        props_url = f"{zoomify_img_path}/ImageProperties.xml"
        props_xml = _fetch_text(session, props_url)
        props = _parse_image_properties(props_xml)

        payload: dict[str, Any] = {
            "xid": xid,
            "zoomifyImgPath": zoomify_img_path,
            "imagePropertiesUrl": props_url,
            **props,
        }
        _zoomify_cache[xid] = payload
        return JSONResponse(payload)
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail="Nepodařilo se načíst zoomify"
        ) from exc


@app.get("/api/corrections")
def get_corrections() -> JSONResponse:
    items = normalize_corrections()
    return JSONResponse({"items": items, "count": len(items)})


@app.get("/api/review-state")
def get_review_state() -> JSONResponse:
    state = build_review_state()
    payload = {
        **state,
        "counts": {
            "corrections": len(state.get("groupCorrections", [])),
            "doneGroups": len(state.get("doneGroupIds", [])),
            "merges": len(state.get("mergeDecisions", [])),
            "knownXids": len(state.get("resolvedGroupByXid", {})),
        },
    }
    return JSONResponse(payload)


@app.post("/api/corrections")
def submit_correction(payload: CorrectionPayload, request: Request) -> JSONResponse:
    email = (payload.email or "").strip()
    if email and not is_valid_email(email):
        raise HTTPException(status_code=400, detail="Neplatný e-mail")

    verdict = (payload.verdict or "").strip().lower()
    has_coordinates = payload.lat is not None and payload.lon is not None
    if not verdict:
        verdict = "wrong" if has_coordinates else "flag"
    if verdict not in {"ok", "wrong", "flag"}:
        raise HTTPException(status_code=400, detail="Neplatný typ hlášení")

    if (payload.lat is None) != (payload.lon is None):
        raise HTTPException(status_code=400, detail="Neplatná poloha")

    if verdict == "ok" and has_coordinates:
        raise HTTPException(
            status_code=400, detail="Potvrzení OK nesmí obsahovat polohu"
        )

    if verdict == "wrong" and not has_coordinates:
        raise HTTPException(status_code=400, detail="Pro opravu je nutná poloha")

    if has_coordinates:
        if (
            payload.lat < -90
            or payload.lat > 90
            or payload.lon < -180
            or payload.lon > 180
        ):
            raise HTTPException(status_code=400, detail="Neplatná poloha")

    if not is_turnstile_bypass():
        if payload.token:
            verify_turnstile(
                payload.token, request.client.host if request.client else None
            )
        elif not _has_valid_session(request):
            raise HTTPException(status_code=400, detail="Turnstile je povinný")

    requested_group_id = (payload.group_id or "").strip()
    xid_group_cache = build_xid_group_cache()
    mapped_group_id = xid_group_cache.get(payload.xid, "")
    if xid_group_cache and not mapped_group_id:
        raise HTTPException(status_code=400, detail="Neznámé xid")
    if mapped_group_id and requested_group_id and requested_group_id != mapped_group_id:
        raise HTTPException(status_code=400, detail="Neplatná skupina pro xid")
    group_id = mapped_group_id or requested_group_id or payload.xid

    record = {
        "id": f"corr_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
        "xid": payload.xid,
        "group_id": group_id or None,
        "lat": payload.lat,
        "lon": payload.lon,
        "has_coordinates": has_coordinates,
        "verdict": verdict,
        "message": (payload.message or "Nahlášena špatná poloha.").strip(),
        "email": email or None,
        "newsletter_opt_in": bool(email),
        "user_agent": request.headers.get("user-agent", ""),
        "received_at": datetime.now(timezone.utc).isoformat(),
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _feedback_lock:
        with CORRECTIONS_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False))
            handle.write("\n")

    return JSONResponse({"ok": True})


def normalize_merges() -> list[dict[str, Any]]:
    return [
        {
            "group_id_a": row["group_id_a"],
            "group_id_b": row["group_id_b"],
            "verdict": row["verdict"],
            "received_at": row.get("received_at"),
        }
        for row in _load_latest_merge_records()
    ]


@app.get("/api/merges")
def get_merges() -> JSONResponse:
    items = normalize_merges()
    return JSONResponse({"items": items, "count": len(items)})


@app.post("/api/merges")
def submit_merge(payload: MergePayload, request: Request) -> JSONResponse:
    group_id_a = payload.group_id_a.strip()
    group_id_b = payload.group_id_b.strip()
    if group_id_a == group_id_b:
        raise HTTPException(status_code=400, detail="Nelze sloučit stejnou skupinu")

    verdict = (payload.verdict or "").strip().lower()
    if not verdict:
        verdict = "same"
    if verdict not in {"same", "different"}:
        raise HTTPException(status_code=400, detail="Neplatný typ rozhodnutí")

    if not is_turnstile_bypass():
        if payload.token:
            verify_turnstile(
                payload.token, request.client.host if request.client else None
            )
        elif not _has_valid_session(request):
            raise HTTPException(status_code=400, detail="Turnstile je povinný")

    if group_id_a > group_id_b:
        group_id_a, group_id_b = group_id_b, group_id_a

    record = {
        "id": f"merge_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
        "group_id_a": group_id_a,
        "group_id_b": group_id_b,
        "verdict": verdict,
        "user_agent": request.headers.get("user-agent", ""),
        "received_at": datetime.now(timezone.utc).isoformat(),
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _feedback_lock:
        with MERGES_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False))
            handle.write("\n")

    return JSONResponse({"ok": True})


@app.post("/api/feedback")
def submit_feedback(payload: FeedbackPayload, request: Request) -> JSONResponse:
    email = (payload.email or "").strip()
    if email and not is_valid_email(email):
        raise HTTPException(status_code=400, detail="Neplatný e-mail")

    if not is_turnstile_bypass():
        if not payload.token:
            raise HTTPException(status_code=400, detail="Turnstile je povinný")
        verify_turnstile(payload.token, request.client.host if request.client else None)

    record = {
        "id": f"fb_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
        "xid": payload.xid,
        "issue": payload.issue,
        "message": payload.message.strip(),
        "email": email or None,
        "newsletter_opt_in": bool(email),
        "user_agent": request.headers.get("user-agent", ""),
        "received_at": datetime.now(timezone.utc).isoformat(),
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _feedback_lock:
        with FEEDBACK_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False))
            handle.write("\n")

    return JSONResponse({"ok": True})


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
