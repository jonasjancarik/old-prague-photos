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
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Load .env for local development
load_dotenv()

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
STATIC_DATA_DIR = STATIC_DIR / "data"
DATA_DIR = ROOT / "data"
PHOTOS_PATH = STATIC_DATA_DIR / "photos.geojson"
FEEDBACK_PATH = DATA_DIR / "feedback.jsonl"
CORRECTIONS_PATH = DATA_DIR / "corrections.jsonl"
MERGES_PATH = DATA_DIR / "merges.jsonl"

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SESSION_COOKIE_NAME = "opp_turnstile_session"
SESSION_TTL_SECONDS = 6 * 60 * 60

app = FastAPI(title="Prohlížeč historických fotografií Prahy")

_photos_cache: dict[str, Any] | None = None
_feedback_lock = Lock()
_zoomify_cache: dict[str, dict[str, Any]] = {}
_xid_group_cache: dict[str, str] | None = None


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
    global _photos_cache
    if _photos_cache is None:
        if not PHOTOS_PATH.exists():
            raise HTTPException(
                status_code=500,
                detail="Chybí GeoJSON. Spusťte viewer/build_geojson.py",
            )
        with PHOTOS_PATH.open(encoding="utf-8") as handle:
            _photos_cache = json.load(handle)
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


def normalize_corrections() -> list[dict[str, Any]]:
    if not CORRECTIONS_PATH.exists():
        return []

    latest_by_group: dict[str, dict[str, Any]] = {}
    latest_coords_by_group: dict[str, dict[str, Any]] = {}
    xid_group = build_xid_group_cache()
    with CORRECTIONS_PATH.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            xid = record.get("xid")
            if not xid:
                continue
            group_id = (
                str(record.get("group_id") or "").strip()
                or xid_group.get(xid)
                or xid
            )
            latest_by_group[group_id] = {
                "xid": xid,
                "group_id": group_id,
                "verdict": record.get("verdict"),
                "received_at": record.get("received_at"),
            }

            has_coordinates = bool(record.get("has_coordinates"))
            if has_coordinates:
                latest_coords_by_group[group_id] = {
                    "lat": record.get("lat"),
                    "lon": record.get("lon"),
                    "has_coordinates": True,
                }

    merged: list[dict[str, Any]] = []
    for group_id, base in latest_by_group.items():
        coords = latest_coords_by_group.get(
            group_id, {"lat": None, "lon": None, "has_coordinates": False}
        )
        merged.append({**base, **coords})

    return merged


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

    group_id = (payload.group_id or "").strip()
    if not group_id:
        group_id = build_xid_group_cache().get(payload.xid, "")

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
    if not MERGES_PATH.exists():
        return []

    latest: dict[str, dict[str, Any]] = {}
    with MERGES_PATH.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            group_id_a = str(record.get("group_id_a") or "").strip()
            group_id_b = str(record.get("group_id_b") or "").strip()
            verdict = str(record.get("verdict") or "").strip().lower()
            if not group_id_a or not group_id_b:
                continue
            if group_id_a == group_id_b:
                continue
            if verdict not in {"same", "different"}:
                continue
            if group_id_a > group_id_b:
                group_id_a, group_id_b = group_id_b, group_id_a
            key = f"{group_id_a}::{group_id_b}"
            latest[key] = {
                "group_id_a": group_id_a,
                "group_id_b": group_id_b,
                "verdict": verdict,
                "received_at": record.get("received_at"),
            }

    return list(latest.values())


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
