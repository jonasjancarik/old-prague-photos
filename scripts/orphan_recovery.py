#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests


DEFAULT_ARCHIVE_BASE_URL = "https://katalog.ahmp.cz/pragapublica"
NOT_FOUND_RE = re.compile(r"Záznam nenalezen", re.IGNORECASE)
PROBE_ACTIVE_FILE = "probe_active.json"
PROBE_NOT_FOUND_FILE = "probe_not_found.json"
PROBE_TRANSIENT_FILE = "probe_transient.json"
PROBE_ATTEMPTS_FILE = "probe_attempts.jsonl"
PROBE_RESULTS_FILE = "probe_results.jsonl"
ELIGIBLE_UNHIDE_FILE = "eligible_unhide.json"
EXCLUDED_AFTER_RECOVERY_FILE = "excluded_after_recovery.json"
SUMMARY_FILE = "summary.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Recover orphan xids with gentle archive probing and readiness gating.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    probe = subparsers.add_parser(
        "probe",
        help="Classify orphan xids as active/not_found/transient with strict pacing.",
    )
    probe.add_argument(
        "--input",
        default="viewer/static/data/orphan_xids.json",
        help="JSON array of xids to probe",
    )
    probe.add_argument(
        "--run-dir",
        required=True,
        help="Run output directory (e.g. output/recovery/orphans/<run_id>)",
    )
    probe.add_argument(
        "--archive-base-url",
        default=DEFAULT_ARCHIVE_BASE_URL,
        help="Archive base URL",
    )
    probe.add_argument(
        "--min-interval",
        type=float,
        default=5.0,
        help="Minimum seconds between archive requests",
    )
    probe.add_argument(
        "--timeout",
        type=float,
        default=12.0,
        help="Request timeout in seconds",
    )
    probe.add_argument(
        "--retries",
        type=int,
        default=2,
        help="Retry count after the first attempt (total attempts = retries + 1)",
    )
    probe.add_argument(
        "--retry-sleep",
        type=float,
        default=5.0,
        help="Sleep seconds between failed attempts (in addition to min interval)",
    )

    seed_retry = subparsers.add_parser(
        "seed-retry",
        help="Seed output/failed_xids.jsonl from probe active+transient lists.",
    )
    seed_retry.add_argument(
        "--run-dir",
        required=True,
        help="Run output directory",
    )
    seed_retry.add_argument(
        "--failed-file",
        default="output/failed_xids.jsonl",
        help="Path to write seeded failed-xid JSONL",
    )

    build_subset = subparsers.add_parser(
        "build-subset",
        help="Create active-only subset GeoJSON for targeted downstream jobs.",
    )
    build_subset.add_argument(
        "--run-dir",
        required=True,
        help="Run output directory",
    )
    build_subset.add_argument(
        "--photos",
        default="viewer/static/data/photos.geojson",
        help="Full photos GeoJSON",
    )
    build_subset.add_argument(
        "--active-file",
        default="",
        help="Override active xid list JSON path",
    )
    build_subset.add_argument(
        "--output",
        default="",
        help="Subset GeoJSON output (default: <run-dir>/active_subset.geojson)",
    )

    finalize = subparsers.add_parser(
        "finalize",
        help="Apply readiness gate and overwrite viewer/static/data/orphan_xids.json.",
    )
    finalize.add_argument(
        "--run-dir",
        required=True,
        help="Run output directory",
    )
    finalize.add_argument(
        "--photos",
        default="viewer/static/data/photos.geojson",
        help="Full photos GeoJSON",
    )
    finalize.add_argument(
        "--raw-dir",
        default="output/raw_records",
        help="Raw records directory",
    )
    finalize.add_argument(
        "--downloads-root",
        default="downloads/archive",
        help="Downloads root (expects previews/<xid>/)",
    )
    finalize.add_argument(
        "--output-orphans",
        default="viewer/static/data/orphan_xids.json",
        help="Final orphan list path to overwrite",
    )
    finalize.add_argument(
        "--active-file",
        default="",
        help="Override active xid list JSON path",
    )
    finalize.add_argument(
        "--not-found-file",
        default="",
        help="Override not_found xid list JSON path",
    )
    finalize.add_argument(
        "--transient-file",
        default="",
        help="Override transient xid list JSON path",
    )

    return parser.parse_args()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def normalize_xid_list(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        xid = str(value or "").strip()
        if not xid or xid in seen:
            continue
        seen.add(xid)
        result.append(xid)
    return result


def read_xid_list(path: Path) -> list[str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return normalize_xid_list(payload)


def write_json(path: Path, payload: Any) -> None:
    ensure_parent(path)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    ensure_parent(path)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def load_probe_results(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        xid = str(payload.get("xid", "")).strip()
        classification = str(payload.get("classification", "")).strip()
        if xid and classification in {"active", "not_found", "transient"}:
            result[xid] = classification
    return result


def permalink_url(archive_base_url: str, xid: str) -> str:
    base = archive_base_url.rstrip("/")
    return f"{base}/permalink?xid={xid}"


def classify_probe_response(status_code: int | None, body: str) -> str | None:
    if status_code in {404, 410}:
        return "not_found"
    if body and NOT_FOUND_RE.search(body):
        return "not_found"
    if status_code == 200:
        return "active"
    return None


class RequestPacer:
    def __init__(
        self,
        min_interval: float,
        *,
        time_fn: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        self.min_interval = max(0.0, float(min_interval))
        self.time_fn = time_fn
        self.sleep_fn = sleep_fn
        self._last_request_started_at: float | None = None

    def wait_turn(self) -> None:
        if self._last_request_started_at is not None and self.min_interval > 0:
            elapsed = self.time_fn() - self._last_request_started_at
            remaining = self.min_interval - elapsed
            if remaining > 0:
                self.sleep_fn(remaining)
        self._last_request_started_at = self.time_fn()


def probe_single_xid(
    xid: str,
    *,
    archive_base_url: str,
    timeout: float,
    retries: int,
    retry_sleep: float,
    session: requests.Session,
    pacer: RequestPacer,
    sleep_fn: Callable[[float], None] = time.sleep,
    time_fn: Callable[[], float] = time.monotonic,
) -> tuple[str, list[dict[str, Any]]]:
    attempts: list[dict[str, Any]] = []
    max_attempts = max(1, int(retries) + 1)
    url = permalink_url(archive_base_url, xid)

    for attempt in range(1, max_attempts + 1):
        pacer.wait_turn()
        started = time_fn()
        status_code: int | None = None
        body = ""
        error = ""
        try:
            response = session.get(url, timeout=timeout)
            status_code = response.status_code
            body = response.text
            classification = classify_probe_response(status_code, body)
        except requests.Timeout:
            classification = None
            error = "timeout"
        except requests.RequestException as exc:
            classification = None
            error = f"request_error:{exc.__class__.__name__}"
        except Exception as exc:
            classification = None
            error = f"error:{exc.__class__.__name__}"

        elapsed_s = round(time_fn() - started, 3)
        is_last = attempt >= max_attempts
        result = classification or ("transient" if is_last else "retry")
        attempts.append(
            {
                "xid": xid,
                "attempt": attempt,
                "max_attempts": max_attempts,
                "url": url,
                "status_code": status_code,
                "elapsed_s": elapsed_s,
                "error": error,
                "result": result,
                "timestamp": utc_now_iso(),
            }
        )
        if classification in {"active", "not_found"}:
            return classification, attempts
        if not is_last:
            sleep_fn(max(0.0, retry_sleep))

    return "transient", attempts


def update_summary(run_dir: Path, key: str, payload: dict[str, Any]) -> None:
    summary_path = run_dir / SUMMARY_FILE
    existing: dict[str, Any] = {}
    if summary_path.exists():
        try:
            loaded = json.loads(summary_path.read_text(encoding="utf-8"))
        except Exception:
            loaded = {}
        if isinstance(loaded, dict):
            existing = loaded
    existing[key] = payload
    write_json(summary_path, existing)


def run_probe(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)

    input_xids = read_xid_list(Path(args.input))
    results_path = run_dir / PROBE_RESULTS_FILE
    attempts_path = run_dir / PROBE_ATTEMPTS_FILE
    existing_results = load_probe_results(results_path)
    pending = [xid for xid in input_xids if xid not in existing_results]

    session = requests.Session()
    session.headers.update({"User-Agent": "old-prague-photos/orphan-recovery-probe"})
    pacer = RequestPacer(min_interval=args.min_interval)
    new_results: dict[str, str] = {}

    for idx, xid in enumerate(pending, start=1):
        classification, attempts = probe_single_xid(
            xid,
            archive_base_url=args.archive_base_url,
            timeout=args.timeout,
            retries=args.retries,
            retry_sleep=args.retry_sleep,
            session=session,
            pacer=pacer,
        )
        for attempt_payload in attempts:
            append_jsonl(attempts_path, attempt_payload)
        result_payload = {
            "xid": xid,
            "classification": classification,
            "attempts": len(attempts),
            "timestamp": utc_now_iso(),
        }
        append_jsonl(results_path, result_payload)
        new_results[xid] = classification
        print(
            f"[probe] {idx}/{len(pending)} xid={xid} classification={classification} attempts={len(attempts)}"
        )

    all_results: dict[str, str] = {}
    all_results.update(existing_results)
    all_results.update(new_results)

    active: list[str] = []
    not_found: list[str] = []
    transient: list[str] = []
    for xid in input_xids:
        classification = all_results.get(xid, "transient")
        if classification == "active":
            active.append(xid)
        elif classification == "not_found":
            not_found.append(xid)
        else:
            transient.append(xid)

    write_json(run_dir / PROBE_ACTIVE_FILE, active)
    write_json(run_dir / PROBE_NOT_FOUND_FILE, not_found)
    write_json(run_dir / PROBE_TRANSIENT_FILE, transient)

    summary_payload = {
        "timestamp": utc_now_iso(),
        "input_count": len(input_xids),
        "resume_skipped": len(existing_results),
        "processed_count": len(pending),
        "active_count": len(active),
        "not_found_count": len(not_found),
        "transient_count": len(transient),
        "attempts_path": str(attempts_path),
        "results_path": str(results_path),
    }
    update_summary(run_dir, "probe", summary_payload)
    print(
        f"[probe] done input={len(input_xids)} active={len(active)} not_found={len(not_found)} transient={len(transient)}"
    )


def dedupe_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        xid = str(item or "").strip()
        if not xid or xid in seen:
            continue
        seen.add(xid)
        result.append(xid)
    return result


def run_seed_retry(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir)
    active_path = run_dir / PROBE_ACTIVE_FILE
    transient_path = run_dir / PROBE_TRANSIENT_FILE
    if not active_path.exists():
        raise SystemExit(f"Missing file: {active_path}")
    if not transient_path.exists():
        raise SystemExit(f"Missing file: {transient_path}")

    active = read_xid_list(active_path)
    transient = read_xid_list(transient_path)
    seeded = dedupe_keep_order(active + transient)

    failed_path = Path(args.failed_file)
    failed_path.parent.mkdir(parents=True, exist_ok=True)
    backup_path = ""
    if failed_path.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup = run_dir / f"failed_xids.backup.{stamp}.jsonl"
        ensure_parent(backup)
        shutil.copy2(failed_path, backup)
        backup_path = str(backup)

    with failed_path.open("w", encoding="utf-8") as handle:
        for xid in seeded:
            handle.write(json.dumps({"xid": xid}, ensure_ascii=False) + "\n")

    summary_payload = {
        "timestamp": utc_now_iso(),
        "active_count": len(active),
        "transient_count": len(transient),
        "seeded_count": len(seeded),
        "failed_file": str(failed_path),
        "backup_path": backup_path,
    }
    update_summary(run_dir, "seed_retry", summary_payload)
    print(
        f"[seed-retry] wrote {len(seeded)} xids to {failed_path}"
        + (f" (backup: {backup_path})" if backup_path else "")
    )


def run_build_subset(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir)
    active_file = Path(args.active_file) if args.active_file else run_dir / PROBE_ACTIVE_FILE
    if not active_file.exists():
        raise SystemExit(f"Missing file: {active_file}")

    output_path = (
        Path(args.output) if args.output else run_dir / "active_subset.geojson"
    )
    active = set(read_xid_list(active_file))
    photos_path = Path(args.photos)
    payload = json.loads(photos_path.read_text(encoding="utf-8"))
    features = payload.get("features", [])
    if not isinstance(features, list):
        raise SystemExit(f"Invalid features in {photos_path}")

    selected = []
    for feature in features:
        props = feature.get("properties", {})
        xid = str(props.get("id", "")).strip() if isinstance(props, dict) else ""
        if xid and xid in active:
            selected.append(feature)

    subset = dict(payload)
    subset["features"] = selected
    write_json(output_path, subset)

    summary_payload = {
        "timestamp": utc_now_iso(),
        "active_count": len(active),
        "subset_feature_count": len(selected),
        "photos_feature_count": len(features),
        "output": str(output_path),
    }
    update_summary(run_dir, "build_subset", summary_payload)
    print(f"[build-subset] wrote {len(selected)} features to {output_path}")


def parse_preview_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item or "").strip() for item in value if str(item or "").strip()]


def has_local_preview(downloads_root: Path, xid: str) -> bool:
    preview_dir = downloads_root / "previews" / xid
    if not preview_dir.exists() or not preview_dir.is_dir():
        return False
    allowed_ext = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".tif", ".tiff"}
    for entry in preview_dir.iterdir():
        if not entry.is_file():
            continue
        if entry.suffix.lower() in allowed_ext:
            return True
    return False


def load_feature_media(
    photos_path: Path,
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    payload = json.loads(photos_path.read_text(encoding="utf-8"))
    features = payload.get("features", [])
    previews_by_xid: dict[str, list[str]] = {}
    zoomify_by_xid: dict[str, list[str]] = {}
    if not isinstance(features, list):
        return previews_by_xid, zoomify_by_xid
    for feature in features:
        if not isinstance(feature, dict):
            continue
        props = feature.get("properties")
        if not isinstance(props, dict):
            continue
        xid = str(props.get("id", "")).strip()
        if not xid:
            continue
        previews = parse_preview_list(props.get("scan_previews"))
        zoomify = parse_preview_list(props.get("scan_zoomify_paths"))
        if previews:
            previews_by_xid[xid] = previews
        if zoomify:
            zoomify_by_xid[xid] = zoomify
    return previews_by_xid, zoomify_by_xid


def load_raw_media(raw_file: Path) -> tuple[list[str], list[str]]:
    try:
        payload = json.loads(raw_file.read_text(encoding="utf-8"))
    except Exception:
        return [], []
    if not isinstance(payload, dict):
        return [], []
    previews = parse_preview_list(payload.get("scan_previews"))
    zoomify = parse_preview_list(payload.get("scan_zoomify_paths"))
    return previews, zoomify


def has_local_zoomify(downloads_root: Path, xid: str) -> bool:
    zoomify_root = downloads_root / "zoomify" / xid
    if not zoomify_root.exists() or not zoomify_root.is_dir():
        return False
    for image_properties in zoomify_root.glob("scan_*/ImageProperties.xml"):
        if image_properties.is_file():
            return True
    return False


def run_finalize(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir)
    active_file = Path(args.active_file) if args.active_file else run_dir / PROBE_ACTIVE_FILE
    not_found_file = (
        Path(args.not_found_file) if args.not_found_file else run_dir / PROBE_NOT_FOUND_FILE
    )
    transient_file = (
        Path(args.transient_file) if args.transient_file else run_dir / PROBE_TRANSIENT_FILE
    )
    for path in [active_file, not_found_file, transient_file]:
        if not path.exists():
            raise SystemExit(f"Missing file: {path}")

    active = read_xid_list(active_file)
    not_found = read_xid_list(not_found_file)
    transient = read_xid_list(transient_file)

    feature_previews, feature_zoomify = load_feature_media(Path(args.photos))
    raw_dir = Path(args.raw_dir)
    downloads_root = Path(args.downloads_root)

    eligible_unhide: list[str] = []
    active_without_readiness: list[str] = []
    missing_raw_count = 0
    missing_preview_count = 0

    for xid in active:
        raw_path = raw_dir / f"{xid}.json"
        raw_exists = raw_path.exists()
        raw_previews, raw_zoomify = load_raw_media(raw_path) if raw_exists else ([], [])
        has_preview_metadata = bool(raw_previews or feature_previews.get(xid))
        has_zoomify_metadata = bool(raw_zoomify or feature_zoomify.get(xid))
        local_preview = has_local_preview(downloads_root, xid)
        local_zoomify = has_local_zoomify(downloads_root, xid)
        media_ready = (
            has_zoomify_metadata
            or local_zoomify
            or has_preview_metadata
            or local_preview
        )
        ready = raw_exists and media_ready
        if ready:
            eligible_unhide.append(xid)
            continue
        active_without_readiness.append(xid)
        if not raw_exists:
            missing_raw_count += 1
        elif not media_ready:
            missing_preview_count += 1

    excluded = sorted(set(not_found) | set(transient) | set(active_without_readiness))
    eligible_sorted = sorted(set(eligible_unhide))

    write_json(run_dir / ELIGIBLE_UNHIDE_FILE, eligible_sorted)
    write_json(run_dir / EXCLUDED_AFTER_RECOVERY_FILE, excluded)
    output_orphans_path = Path(args.output_orphans)
    write_json(output_orphans_path, excluded)

    summary_payload = {
        "timestamp": utc_now_iso(),
        "active_count": len(active),
        "not_found_count": len(not_found),
        "transient_count": len(transient),
        "eligible_unhide_count": len(eligible_sorted),
        "active_without_readiness_count": len(active_without_readiness),
        "missing_raw_count": missing_raw_count,
        "missing_preview_count": missing_preview_count,
        "excluded_count": len(excluded),
        "eligible_unhide_file": str(run_dir / ELIGIBLE_UNHIDE_FILE),
        "excluded_after_recovery_file": str(run_dir / EXCLUDED_AFTER_RECOVERY_FILE),
        "output_orphans": str(output_orphans_path),
    }
    update_summary(run_dir, "finalize", summary_payload)
    print(
        "[finalize] "
        f"eligible_unhide={len(eligible_sorted)} excluded={len(excluded)} "
        f"output={output_orphans_path}"
    )


def main() -> None:
    args = parse_args()
    if args.command == "probe":
        run_probe(args)
    elif args.command == "seed-retry":
        run_seed_retry(args)
    elif args.command == "build-subset":
        run_build_subset(args)
    elif args.command == "finalize":
        run_finalize(args)
    else:
        raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()
