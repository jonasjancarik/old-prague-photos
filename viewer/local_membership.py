import json
from pathlib import Path
from typing import Any


def _normalize(value: Any) -> str:
    return str(value or "").strip()


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def load_membership_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    events: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for sequence, line in enumerate(handle, start=1):
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            source_group_id = _normalize(record.get("source_group_id"))
            target_group_id = _normalize(record.get("target_group_id"))
            assignments = sorted(
                {
                    _normalize(value)
                    for value in record.get("assignments", [])
                    if _normalize(value)
                }
            )
            if not source_group_id or not target_group_id or not assignments:
                continue
            raw_boundaries = record.get("review_boundaries") or {}
            review_boundaries = {
                _normalize(group_id): _nonnegative_int(through_sequence)
                for group_id, through_sequence in raw_boundaries.items()
                if _normalize(group_id)
            }
            events.append(
                {
                    **record,
                    "source_group_id": source_group_id,
                    "target_group_id": target_group_id,
                    "assignments": assignments,
                    "review_boundaries": review_boundaries,
                    "_seq": sequence,
                }
            )
    return events


def apply_membership_events(
    base_membership: dict[str, str],
    path: Path,
) -> dict[str, str]:
    resolved = dict(base_membership)
    for event in load_membership_events(path):
        target_group_id = event["target_group_id"]
        for xid in event["assignments"]:
            if xid in resolved:
                resolved[xid] = target_group_id
    return resolved


def review_resolution_boundaries(path: Path) -> dict[str, int]:
    boundaries: dict[str, int] = {}
    for event in load_membership_events(path):
        for group_id, through_sequence in event["review_boundaries"].items():
            boundaries[group_id] = max(
                boundaries.get(group_id, 0),
                through_sequence,
            )
    return boundaries
