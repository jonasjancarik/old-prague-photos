#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_ARTIFACTS = [
    "output/available_record_ids.json",
    "output/old_prague_photos.csv",
    "viewer/static/data/photos.geojson",
    "viewer/static/data/similarity_candidates.json",
    "viewer/static/data/series_version_clusters.json",
]

DEFAULT_COUNT_DIRS = [
    "output/raw_records",
    "output/geolocation/ok",
    "output/geolocation/failed",
    "downloads/archive/previews",
    "downloads/archive/zoomify",
]

ENV_KEYS = [
    "ARCHIVE_BASE_URL",
    "ALLOW_ARCHIVE_FALLBACK",
    "USE_NAV_PARTITION",
    "NAV_PARTITION_LABEL",
    "NAV_RESUME",
    "NAV_MAX_NODES",
    "NAV_ONLY_LABELS",
    "ARCHIVE_REQUEST_DELAY_S",
    "ARCHIVE_RECORD_DELAY_S",
    "ARCHIVE_FETCH_RETRIES",
    "ARCHIVE_MAX_ROWS",
    "CONCURRENT_REQUESTS",
    "MAPY_REQUEST_DELAY_S",
    "MAPY_REQUEST_RETRIES",
    "MAPY_REQUEST_TIMEOUT_S",
    "MAPY_ALLOW_FALLBACK",
    "LLM_MODEL",
    "R2_TILES_BASE",
]

SECRET_MARKERS = ("KEY", "SECRET", "TOKEN", "PASSWORD")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Write a reproducibility manifest for pipeline outputs.",
    )
    parser.add_argument(
        "--output",
        default="output/pipeline_manifest.json",
        help="Manifest JSON path",
    )
    parser.add_argument(
        "--artifact",
        action="append",
        default=[],
        help="Additional artifact path to hash",
    )
    parser.add_argument(
        "--count-dir",
        action="append",
        default=[],
        help="Additional directory path to count",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_value(args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    return result.stdout.strip()


def artifact_info(root: Path, relative_path: str) -> dict[str, Any]:
    path = root / relative_path
    if not path.exists():
        return {"path": relative_path, "exists": False}
    return {
        "path": relative_path,
        "exists": True,
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def directory_info(root: Path, relative_path: str) -> dict[str, Any]:
    path = root / relative_path
    if not path.exists():
        return {"path": relative_path, "exists": False, "file_count": 0}
    return {
        "path": relative_path,
        "exists": True,
        "file_count": sum(1 for item in path.rglob("*") if item.is_file()),
    }


def env_snapshot() -> dict[str, Any]:
    snapshot: dict[str, Any] = {}
    for key in ENV_KEYS:
        value = os.getenv(key)
        if value is None:
            continue
        if any(marker in key for marker in SECRET_MARKERS):
            snapshot[key] = {"present": True}
        else:
            snapshot[key] = value
    return snapshot


def build_manifest(
    root: Path,
    artifacts: list[str] | None = None,
    count_dirs: list[str] | None = None,
    include_defaults: bool = True,
) -> dict[str, Any]:
    artifact_paths = [
        *(DEFAULT_ARTIFACTS if include_defaults else []),
        *(artifacts or []),
    ]
    count_dir_paths = [
        *(DEFAULT_COUNT_DIRS if include_defaults else []),
        *(count_dirs or []),
    ]
    status_short = git_value(["status", "--short"])
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "git": {
            "commit": git_value(["rev-parse", "HEAD"]),
            "branch": git_value(["branch", "--show-current"]),
            "dirty": bool(status_short),
            "status_short": status_short,
        },
        "environment": env_snapshot(),
        "artifacts": [artifact_info(root, path) for path in artifact_paths],
        "directories": [directory_info(root, path) for path in count_dir_paths],
    }


def main() -> None:
    args = parse_args()
    root = Path.cwd()
    manifest = build_manifest(root, artifacts=args.artifact, count_dirs=args.count_dir)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote manifest to {output_path}")


if __name__ == "__main__":
    main()
