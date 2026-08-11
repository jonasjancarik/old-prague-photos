from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from scripts.write_pipeline_manifest import build_manifest
from src.pipeline.atomic_io import atomic_write_json
from src.pipeline.paths import PipelinePaths


def append_stage_event(
    paths: PipelinePaths,
    stage: str,
    *,
    status: str = "completed",
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "stage": stage,
        "status": status,
        "details": details or {},
    }
    paths.stage_log_path.parent.mkdir(parents=True, exist_ok=True)
    with paths.stage_log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    return event


def write_run_manifest(paths: PipelinePaths) -> dict[str, Any]:
    manifest = build_manifest(
        paths.root,
        artifacts=paths.manifest_artifacts(),
        count_dirs=paths.manifest_count_dirs(),
        include_defaults=False,
    )
    atomic_write_json(
        paths.manifest_path,
        manifest,
        indent=2,
        trailing_newline=True,
    )
    return manifest
