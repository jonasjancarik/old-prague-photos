import hashlib
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.release_baseline_inventory import (
    DEFAULT_TARGETS,
    TargetSpec,
    build_manifest,
    inventory_target,
    verify_manifest,
    write_manifest,
)


class ReleaseBaselineInventoryTests(unittest.TestCase):
    def test_inventory_is_sorted_and_has_reproducible_aggregate(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache = root / "cache"
            cache.mkdir()
            (cache / "b.bin").write_bytes(b"second")
            (cache / "a.bin").write_bytes(b"first")

            first = inventory_target(root, TargetSpec("cache", ("cache",)))
            second = inventory_target(root, TargetSpec("cache", ("cache",)))

        self.assertEqual(first, second)
        self.assertEqual(
            [entry["path"] for entry in first["files"]],
            ["cache/a.bin", "cache/b.bin"],
        )
        canonical_lines = b"".join(
            json.dumps(
                entry,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
            + b"\n"
            for entry in first["files"]
        )
        self.assertEqual(
            first["aggregate_sha256"],
            hashlib.sha256(canonical_lines).hexdigest(),
        )
        self.assertEqual(first["file_count"], 2)
        self.assertEqual(first["size_bytes"], 11)

    def test_selector_filters_suffixes_exclusions_and_records_absent_paths(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "media" / "excluded").mkdir(parents=True)
            (root / "media" / "photo.JPG").write_bytes(b"photo")
            (root / "media" / "notes.json").write_text("{}", encoding="utf-8")
            (root / "media" / "ignored.jpg").write_bytes(b"runtime noise")
            (root / "media" / "excluded" / "other.jpg").write_bytes(b"other")

            inventory = inventory_target(
                root,
                TargetSpec(
                    "media",
                    ("media", "not-created"),
                    include_suffixes=(".jpg",),
                    exclude_paths=("media/excluded",),
                    exclude_names=("ignored.jpg",),
                ),
            )

        self.assertEqual(inventory["absent_paths"], ["not-created"])
        self.assertEqual(inventory["file_count"], 1)
        self.assertEqual(inventory["files"][0]["path"], "media/photo.JPG")

    def test_build_manifest_rejects_overlapping_targets(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "cache").mkdir()
            (root / "cache" / "one.bin").write_bytes(b"one")

            with self.assertRaisesRegex(ValueError, "overlap"):
                build_manifest(
                    root,
                    (
                        TargetSpec("first", ("cache",)),
                        TargetSpec("second", ("cache/one.bin",)),
                    ),
                )

    def test_verify_reports_changed_file_without_writing_corpus(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache = root / "cache"
            cache.mkdir()
            corpus_file = cache / "one.bin"
            corpus_file.write_bytes(b"before")
            manifest_path = root / "baseline.json"
            manifest = build_manifest(
                root,
                (TargetSpec("cache", ("cache",)),),
                baseline_id="test-baseline",
            )
            write_manifest(manifest_path, manifest)

            targets = (TargetSpec("cache", ("cache",)),)
            self.assertEqual(verify_manifest(root, manifest_path, targets), [])
            corpus_file.write_bytes(b"after")
            differences = verify_manifest(root, manifest_path, targets)

        self.assertTrue(any("cache/one.bin" in item for item in differences))
        self.assertTrue(any("aggregate_sha256" in item for item in differences))

    def test_verify_cannot_narrow_the_scope_through_manifest_selector(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "cache").mkdir()
            (root / "cache" / "one.bin").write_bytes(b"one")
            targets = (TargetSpec("cache", ("cache",)),)
            manifest = build_manifest(root, targets, baseline_id="test-baseline")
            manifest["targets"][0]["selector"]["paths"] = []
            manifest_path = root / "baseline.json"
            write_manifest(manifest_path, manifest)

            differences = verify_manifest(root, manifest_path, targets)

        self.assertIn("cache selector changed", differences)

    def test_paths_cannot_escape_repository(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with self.assertRaisesRegex(ValueError, "repository-relative"):
                inventory_target(
                    Path(tmpdir),
                    TargetSpec("unsafe", ("../private.sqlite",)),
                )

    def test_default_targets_do_not_select_private_runtime_state(self) -> None:
        selected_paths = {
            path
            for target in DEFAULT_TARGETS
            for path in (*target.paths, *target.exclude_paths)
        }
        self.assertFalse(
            any(
                path == ".wrangler" or path.startswith(".wrangler/")
                for path in selected_paths
            )
        )


if __name__ == "__main__":
    unittest.main()
