#!/usr/bin/env python3
"""Create and verify deterministic inventories of ignored release caches.

This module deliberately has no pipeline-runtime dependencies. It reads the
selected files, hashes them, and writes only the requested JSON manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence


SCHEMA_VERSION = 1
DEFAULT_BASELINE_ID = "release-baseline-2026-08-11"
DEFAULT_MANIFEST_PATH = Path("data-snapshots/release-baseline-2026-08-11.json")
MEDIA_SUFFIXES = (".jpeg", ".jpg", ".png", ".webp")


@dataclass(frozen=True)
class TargetSpec:
    """A named, non-overlapping set of repository-relative files."""

    name: str
    paths: tuple[str, ...]
    include_suffixes: tuple[str, ...] = ()
    exclude_paths: tuple[str, ...] = ()
    exclude_names: tuple[str, ...] = ()


DEFAULT_TARGETS = (
    TargetSpec(
        name="similarity-stitched",
        paths=("output/similarity/stitched",),
    ),
    TargetSpec(
        name="similarity-candidate-rescore-stitched",
        paths=("output/similarity/eval/candidate-rescore-stitched",),
    ),
    TargetSpec(
        name="archive-download-cache",
        paths=("downloads/archive",),
        exclude_names=(".DS_Store",),
    ),
    TargetSpec(
        name="similarity-evaluation-media",
        paths=("output/similarity/eval",),
        include_suffixes=MEDIA_SUFFIXES,
        exclude_paths=(
            "output/similarity/eval/candidate-rescore-stitched",
        ),
    ),
    TargetSpec(
        name="orphan-recovery-media",
        paths=("output/recovery/orphans",),
        include_suffixes=MEDIA_SUFFIXES,
    ),
    TargetSpec(
        name="similarity-cache-backups",
        paths=(
            "output/similarity/errors.jsonl.pre-refresh-backup",
            "output/similarity/hashes.jsonl.bak-20260210-113221",
            "output/similarity/hashes.jsonl.pre-v2-backup",
        ),
    ),
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validated_relative_path(path: str) -> str:
    parsed = PurePosixPath(path)
    if parsed.is_absolute() or ".." in parsed.parts or parsed.as_posix() in {"", "."}:
        raise ValueError(f"inventory paths must be repository-relative: {path!r}")
    return parsed.as_posix()


def _is_at_or_below(path: str, parent: str) -> bool:
    return path == parent or path.startswith(f"{parent}/")


def _selected(path: str, spec: TargetSpec) -> bool:
    if any(_is_at_or_below(path, excluded) for excluded in spec.exclude_paths):
        return False
    if PurePosixPath(path).name in spec.exclude_names:
        return False
    if not spec.include_suffixes:
        return True
    return PurePosixPath(path).suffix.lower() in spec.include_suffixes


def _assert_within_root(root: Path, path: Path) -> None:
    resolved_root = root.resolve()
    resolved_path = path.resolve(strict=False)
    if not resolved_path.is_relative_to(resolved_root):
        raise ValueError(f"inventory path leaves repository root: {path}")


def _file_entry(root: Path, path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise ValueError(f"refusing to inventory symbolic link: {path}")
    relative_path = path.relative_to(root).as_posix()
    before = path.stat()
    digest = sha256_file(path)
    after = path.stat()
    before_signature = (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )
    after_signature = (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    )
    if before_signature != after_signature:
        raise RuntimeError(f"file changed while it was being inventoried: {path}")
    return {
        "path": relative_path,
        "size_bytes": after.st_size,
        "sha256": digest,
    }


def _aggregate_sha256(entries: Iterable[dict[str, Any]]) -> str:
    """Hash canonical JSONL records ordered by repository-relative path."""

    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: item["path"]):
        encoded = json.dumps(
            entry,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        digest.update(encoded)
        digest.update(b"\n")
    return digest.hexdigest()


def inventory_target(root: Path, spec: TargetSpec) -> dict[str, Any]:
    root = root.resolve()
    normalized = TargetSpec(
        name=spec.name,
        paths=tuple(_validated_relative_path(path) for path in spec.paths),
        include_suffixes=tuple(
            sorted(suffix.lower() for suffix in spec.include_suffixes)
        ),
        exclude_paths=tuple(
            sorted(_validated_relative_path(path) for path in spec.exclude_paths)
        ),
        exclude_names=tuple(sorted(spec.exclude_names)),
    )
    entries: dict[str, dict[str, Any]] = {}
    absent_paths: list[str] = []

    for relative_path in normalized.paths:
        source = root / relative_path
        _assert_within_root(root, source)
        if source.is_symlink():
            raise ValueError(f"refusing to inventory symbolic link: {source}")
        if not source.exists():
            absent_paths.append(relative_path)
            continue

        candidates = [source] if source.is_file() else source.rglob("*")
        for candidate in candidates:
            if candidate.is_symlink():
                raise ValueError(f"refusing to inventory symbolic link: {candidate}")
            if not candidate.is_file():
                continue
            relative_candidate = candidate.relative_to(root).as_posix()
            if not _selected(relative_candidate, normalized):
                continue
            entries[relative_candidate] = _file_entry(root, candidate)

    files = sorted(entries.values(), key=lambda item: item["path"])
    return {
        "name": normalized.name,
        "selector": {
            "paths": list(normalized.paths),
            "include_suffixes": list(normalized.include_suffixes),
            "exclude_paths": list(normalized.exclude_paths),
            "exclude_names": list(normalized.exclude_names),
        },
        "absent_paths": sorted(absent_paths),
        "file_count": len(files),
        "size_bytes": sum(entry["size_bytes"] for entry in files),
        "aggregate_sha256": _aggregate_sha256(files),
        "files": files,
    }


def build_manifest(
    root: Path,
    targets: Sequence[TargetSpec] = DEFAULT_TARGETS,
    *,
    baseline_id: str = DEFAULT_BASELINE_ID,
) -> dict[str, Any]:
    inventories = [inventory_target(root, spec) for spec in targets]
    all_entries: list[dict[str, Any]] = []
    owner_by_path: dict[str, str] = {}
    for inventory in inventories:
        for entry in inventory["files"]:
            path = entry["path"]
            previous_owner = owner_by_path.get(path)
            if previous_owner is not None:
                raise ValueError(
                    f"inventory targets overlap at {path}: "
                    f"{previous_owner!r} and {inventory['name']!r}"
                )
            owner_by_path[path] = inventory["name"]
            all_entries.append(entry)

    all_entries.sort(key=lambda item: item["path"])
    absent_paths = sorted(
        {
            path
            for inventory in inventories
            for path in inventory["absent_paths"]
        }
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "baseline_id": baseline_id,
        "hash_algorithm": "sha256",
        "aggregate_encoding": (
            "UTF-8 canonical JSON Lines of each {path,sha256,size_bytes} record, "
            "sorted by path and terminated by LF"
        ),
        "absent_paths": absent_paths,
        "totals": {
            "file_count": len(all_entries),
            "size_bytes": sum(entry["size_bytes"] for entry in all_entries),
            "aggregate_sha256": _aggregate_sha256(all_entries),
        },
        "targets": inventories,
    }


def compare_manifests(
    expected: dict[str, Any], current: dict[str, Any]
) -> list[str]:
    differences: list[str] = []
    for key in (
        "schema_version",
        "baseline_id",
        "hash_algorithm",
        "aggregate_encoding",
    ):
        if expected.get(key) != current.get(key):
            differences.append(
                f"{key} changed: expected {expected.get(key)!r}, "
                f"found {current.get(key)!r}"
            )
    if expected.get("absent_paths") != current.get("absent_paths"):
        differences.append(
            "absent paths changed: "
            f"expected {expected.get('absent_paths')}, "
            f"found {current.get('absent_paths')}"
        )

    expected_targets = {target["name"]: target for target in expected["targets"]}
    current_targets = {target["name"]: target for target in current["targets"]}
    if expected_targets.keys() != current_targets.keys():
        differences.append("target names changed")
    for name in sorted(expected_targets.keys() & current_targets.keys()):
        old = expected_targets[name]
        new = current_targets[name]
        if old.get("selector") != new.get("selector"):
            differences.append(f"{name} selector changed")
        for key in ("file_count", "size_bytes", "aggregate_sha256"):
            if old.get(key) != new.get(key):
                differences.append(
                    f"{name} {key}: expected {old.get(key)}, found {new.get(key)}"
                )

        old_files = {entry["path"]: entry for entry in old["files"]}
        new_files = {entry["path"]: entry for entry in new["files"]}
        added = sorted(new_files.keys() - old_files.keys())
        removed = sorted(old_files.keys() - new_files.keys())
        changed = sorted(
            path
            for path in old_files.keys() & new_files.keys()
            if old_files[path] != new_files[path]
        )
        for label, paths in (
            ("added", added),
            ("removed", removed),
            ("changed", changed),
        ):
            if paths:
                preview = ", ".join(paths[:5])
                remainder = len(paths) - 5
                suffix = f" (+{remainder} more)" if remainder > 0 else ""
                differences.append(f"{name} {label}: {preview}{suffix}")

    if expected.get("totals") != current.get("totals"):
        differences.append(
            f"totals changed: expected {expected.get('totals')}, "
            f"found {current.get('totals')}"
        )
    return differences


def verify_manifest(
    root: Path,
    manifest_path: Path,
    targets: Sequence[TargetSpec] = DEFAULT_TARGETS,
) -> list[str]:
    expected = json.loads(manifest_path.read_text(encoding="utf-8"))
    if expected.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"unsupported release baseline schema: {expected.get('schema_version')!r}"
        )
    current = build_manifest(
        root,
        targets,
        baseline_id=expected["baseline_id"],
    )
    return compare_manifests(expected, current)


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _path_from_root(root: Path, path: Path) -> Path:
    return path if path.is_absolute() else root / path


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Write or verify the ignored-cache release baseline.",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path.cwd(),
        help="Repository root (defaults to the current directory)",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    write_parser = commands.add_parser("write", help="Write the baseline manifest")
    write_parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_MANIFEST_PATH,
        help=f"Output path (default: {DEFAULT_MANIFEST_PATH})",
    )
    write_parser.add_argument(
        "--baseline-id",
        default=DEFAULT_BASELINE_ID,
        help=f"Stable baseline identifier (default: {DEFAULT_BASELINE_ID})",
    )

    verify_parser = commands.add_parser(
        "verify", help="Verify all files against an existing manifest"
    )
    verify_parser.add_argument("manifest", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    root = args.root.resolve()
    if args.command == "write":
        output_path = _path_from_root(root, args.output)
        manifest = build_manifest(root, baseline_id=args.baseline_id)
        write_manifest(output_path, manifest)
        print(
            f"Wrote {manifest['totals']['file_count']} files "
            f"({manifest['totals']['size_bytes']} bytes) to {output_path}"
        )
        return 0

    manifest_path = _path_from_root(root, args.manifest)
    differences = verify_manifest(root, manifest_path)
    if differences:
        print(f"Release baseline verification failed for {manifest_path}:")
        for difference in differences:
            print(f"- {difference}")
        return 1
    print(f"Release baseline verified: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
