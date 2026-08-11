from __future__ import annotations

import base64
import json
import re
from typing import Any


def _normalize_id(value: Any) -> str:
    return str(value or "").strip()


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _pair_key(left: str, right: str) -> str:
    if not left or not right or left == right:
        return ""
    return f"{left}::{right}" if left < right else f"{right}::{left}"


def _location_revision(group_id: str, anchor_id: Any = None) -> str:
    return json.dumps(
        [_normalize_id(group_id), _normalize_id(anchor_id) or None],
        ensure_ascii=False,
        separators=(",", ":"),
    )


class StaleCandidateCursorError(ValueError):
    pass


def build_effective_groups(
    features: list[dict[str, Any]],
    orphan_ids: set[str],
    review_state: dict[str, Any],
) -> list[dict[str, Any]]:
    resolved_by_xid = review_state.get("resolvedGroupByXid", {})
    corrections = {
        _normalize_id(item.get("group_id")): item
        for item in review_state.get("groupCorrections", [])
        if _normalize_id(item.get("group_id"))
    }
    groups: dict[str, dict[str, Any]] = {}

    for source in features:
        source_props = source.get("properties") or {}
        xid = _normalize_id(source_props.get("id"))
        if not xid or xid in orphan_ids:
            continue
        group_id = (
            _normalize_id(resolved_by_xid.get(xid))
            or _normalize_id(source_props.get("group_id"))
            or xid
        )
        correction = corrections.get(group_id, {})
        coordinates = list((source.get("geometry") or {}).get("coordinates") or [])[:2]
        original_coordinates = list(coordinates)
        corrected_lat = _finite(correction.get("lat"))
        corrected_lon = _finite(correction.get("lon"))
        proposed_lat = _finite(correction.get("proposed_lat"))
        proposed_lon = _finite(correction.get("proposed_lon"))
        proposed_id = _normalize_id(correction.get("proposed_id"))
        if corrected_lat is not None and corrected_lon is not None:
            coordinates = [corrected_lon, corrected_lat]

        properties = {
            **source_props,
            "original_coordinates": original_coordinates,
            "group_root": group_id,
            "correction_state": correction.get("correction_state", "none"),
            "anchor_type": correction.get("anchor_type", "none"),
            "anchor_id": _normalize_id(correction.get("anchor_id")) or None,
            "needs_confirmation": bool(correction.get("needs_confirmation")),
            "location_revision": _normalize_id(
                correction.get("location_revision")
            )
            or _location_revision(group_id, correction.get("anchor_id")),
            "proposed_id": proposed_id or None,
            "proposed_has_coordinates": bool(
                correction.get("proposed_has_coordinates")
                and proposed_lat is not None
                and proposed_lon is not None
            ),
            "proposed_lat": proposed_lat,
            "proposed_lon": proposed_lon,
        }
        if corrected_lat is not None and corrected_lon is not None:
            properties["corrected"] = {"lat": corrected_lat, "lon": corrected_lon}
        feature = {
            "type": source.get("type", "Feature"),
            "geometry": {
                "type": (source.get("geometry") or {}).get("type", "Point"),
                "coordinates": coordinates,
            },
            "properties": properties,
        }
        groups.setdefault(group_id, {"id": group_id, "items": []})["items"].append(
            feature
        )

    output: list[dict[str, Any]] = []
    for group in groups.values():
        group["items"].sort(
            key=lambda item: (
                _normalize_id((item.get("properties") or {}).get("signature")),
                _normalize_id((item.get("properties") or {}).get("id")),
            )
        )
        group["primary"] = group["items"][0]
        coordinates = (group["primary"].get("geometry") or {}).get("coordinates") or []
        group["lon"] = _finite(coordinates[0]) if len(coordinates) > 0 else None
        group["lat"] = _finite(coordinates[1]) if len(coordinates) > 1 else None
        output.append(group)
    output.sort(key=lambda group: group["id"])
    return output


def remap_version_clusters(
    clusters: list[dict[str, Any]],
    groups: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    group_by_xid = {
        _normalize_id((feature.get("properties") or {}).get("id")): group["id"]
        for group in groups
        for feature in group.get("items", [])
        if _normalize_id((feature.get("properties") or {}).get("id"))
    }
    fragments_by_group: dict[str, list[dict[str, Any]]] = {}
    for cluster in clusters:
        buckets: dict[str, list[str]] = {}
        for value in cluster.get("xids", []):
            xid = _normalize_id(value)
            group_id = group_by_xid.get(xid, "")
            if xid and group_id:
                buckets.setdefault(group_id, []).append(xid)
        for group_id, values in buckets.items():
            xids = sorted(set(values))
            representative = _normalize_id(cluster.get("representative_xid"))
            fragments_by_group.setdefault(group_id, []).append(
                {
                    "source_series_id": _normalize_id(cluster.get("series_id")),
                    "source_version_id": _normalize_id(cluster.get("version_id")),
                    "xids": xids,
                    "representative_xid": (
                        representative if representative in xids else xids[0]
                    ),
                    "max_distance": cluster.get("max_distance"),
                }
            )

    remapped: dict[str, list[dict[str, Any]]] = {}
    for group_id, fragments in fragments_by_group.items():
        fragments.sort(
            key=lambda item: (
                item["source_series_id"],
                item["source_version_id"],
                item["xids"][0],
            )
        )
        remapped[group_id] = [
            {
                "series_id": group_id,
                "version_id": f"v{index}",
                "xids": fragment["xids"],
                "representative_xid": fragment["representative_xid"],
                "max_distance": fragment["max_distance"],
            }
            for index, fragment in enumerate(fragments, start=1)
        ]
    return remapped


def build_duplicate_candidates(
    groups: list[dict[str, Any]],
    similarity_pairs: list[dict[str, Any]],
    review_state: dict[str, Any],
    focus_group_id: str = "",
    max_coordinate_neighbors: int = 8,
) -> list[dict[str, Any]]:
    group_by_id = {group["id"]: group for group in groups}
    roots = review_state.get("groupRoots", {})

    def resolve(value: Any) -> str:
        group_id = _normalize_id(value)
        return _normalize_id(roots.get(group_id)) or group_id

    focus = resolve(focus_group_id)
    decided = {
        key
        for item in review_state.get("mergeDecisions", [])
        if _normalize_id(item.get("verdict")).lower() in {"same", "different"}
        if (key := _pair_key(resolve(item.get("group_id_a")), resolve(item.get("group_id_b"))))
    }
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(left: dict[str, Any] | None, right: dict[str, Any] | None, source: str) -> None:
        if not left or not right:
            return
        if focus and left["id"] != focus and right["id"] != focus:
            return
        key = _pair_key(left["id"], right["id"])
        if not key or key in decided or key in seen:
            return
        seen.add(key)
        candidates.append({"key": key, "source": source, "groupA": left, "groupB": right})

    resolved_by_xid = review_state.get("resolvedGroupByXid", {})
    for item in similarity_pairs:
        left_id = resolve(
            resolved_by_xid.get(_normalize_id(item.get("xid_a")))
            or item.get("group_id_a")
        )
        right_id = resolve(
            resolved_by_xid.get(_normalize_id(item.get("xid_b")))
            or item.get("group_id_b")
        )
        add(group_by_id.get(left_id), group_by_id.get(right_id), "similarity")

    by_coordinate: dict[str, list[dict[str, Any]]] = {}
    for group in groups:
        lat = _finite(group.get("lat"))
        lon = _finite(group.get("lon"))
        if lat is None or lon is None:
            continue
        by_coordinate.setdefault(f"{lat:.6f},{lon:.6f}", []).append(group)

    for coordinate_groups in by_coordinate.values():
        if len(coordinate_groups) < 2:
            continue
        coordinate_groups.sort(key=lambda group: group["id"])
        neighbors = min(max(1, max_coordinate_neighbors), len(coordinate_groups) - 1)
        for index, left in enumerate(coordinate_groups):
            for distance in range(1, neighbors + 1):
                add(left, coordinate_groups[(index + distance) % len(coordinate_groups)], "coords")
    return candidates


def paginate(
    items: list[Any],
    cursor: str | int,
    limit: int,
    revision: int = 0,
    data_version: str = "",
) -> dict[str, Any]:
    version_token = (
        base64.urlsafe_b64encode(str(data_version).strip().encode("utf-8"))
        .decode("ascii")
        .rstrip("=")
        or "none"
    )
    raw_cursor = str(cursor or "").strip()
    if not raw_cursor or raw_cursor == "0":
        offset = 0
    else:
        match = re.fullmatch(r"v([A-Za-z0-9_-]+):r(\d+):(\d+)", raw_cursor)
        if (
            not match
            or match.group(1) != version_token
            or int(match.group(2)) != int(revision)
        ):
            raise StaleCandidateCursorError(
                "Candidate cursor belongs to an older community revision"
            )
        offset = int(match.group(3))
    page_size = min(50, max(1, limit))
    page = items[offset : offset + page_size]
    next_offset = offset + len(page)
    return {
        "items": page,
        "total": len(items),
        "cursor": f"v{version_token}:r{int(revision)}:{offset}",
        "nextCursor": (
            f"v{version_token}:r{int(revision)}:{next_offset}"
            if next_offset < len(items)
            else None
        ),
        "limit": page_size,
        "revision": int(revision),
    }
