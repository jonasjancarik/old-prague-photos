import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from scripts.write_pipeline_manifest import build_manifest, directory_info, sha256_file
from src.pipeline.paths import PipelinePaths
from src.pipeline.run_manifest import append_stage_event, write_run_manifest


class PipelineManifestTests(unittest.TestCase):
    def test_sha256_file(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "artifact.txt"
            path.write_text("hello", encoding="utf-8")

            self.assertEqual(
                sha256_file(path),
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            )

    def test_build_manifest_records_artifacts_and_counts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            artifact = root / "out.json"
            counted = root / "records"
            counted.mkdir()
            artifact.write_text(json.dumps({"ok": True}), encoding="utf-8")
            (counted / "one.json").write_text("{}", encoding="utf-8")
            counted_sha = sha256_file(counted / "one.json")

            with patch(
                "scripts.write_pipeline_manifest.git_value",
                return_value="",
            ):
                manifest = build_manifest(
                    root,
                    artifacts=["out.json"],
                    count_dirs=["records"],
                )

        artifact_info = [
            item for item in manifest["artifacts"] if item["path"] == "out.json"
        ][0]
        directory_info = [
            item for item in manifest["directories"] if item["path"] == "records"
        ][0]
        self.assertTrue(artifact_info["exists"])
        self.assertEqual(directory_info["file_count"], 1)
        self.assertEqual(directory_info["files"][0]["path"], "one.json")
        self.assertEqual(directory_info["files"][0]["sha256"], counted_sha)

    def test_directory_digest_changes_when_content_changes_at_same_count(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            records = root / "records"
            records.mkdir()
            path = records / "one.json"
            path.write_text('{"value":1}', encoding="utf-8")
            before = directory_info(root, "records")

            path.write_text('{"value":2}', encoding="utf-8")
            after = directory_info(root, "records")

        self.assertEqual(before["file_count"], after["file_count"])
        self.assertNotEqual(
            before["directory_root_sha256"],
            after["directory_root_sha256"],
        )

    def test_run_manifest_records_stage_log(self) -> None:
        with TemporaryDirectory() as tmpdir:
            paths = PipelinePaths.from_run_dir(Path(tmpdir) / "run")
            paths.create()
            append_stage_event(paths, "collect", details={"ids_only": True})

            with patch(
                "scripts.write_pipeline_manifest.git_value",
                return_value="",
            ):
                manifest = write_run_manifest(paths)

            stage_log = paths.stage_log_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(stage_log), 1)
            self.assertEqual(json.loads(stage_log[0])["stage"], "collect")

            artifact_paths = [item["path"] for item in manifest["artifacts"]]
            self.assertIn("stage_log.jsonl", artifact_paths)
            self.assertTrue(paths.manifest_path.exists())


if __name__ == "__main__":
    unittest.main()
