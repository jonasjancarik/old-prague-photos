import csv
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from src.pipeline.derive import derive_snapshot
from src.pipeline.paths import PipelinePaths


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def make_publishable_paths(root: Path, xid: str = "A1") -> PipelinePaths:
    paths = PipelinePaths.from_run_dir(root / "run")
    paths.create(config={"schema_version": 1})
    write_json(paths.raw_records_dir / f"{xid}.json", {"xid": xid})
    write_json(
        paths.geolocation_ok_dir / f"{xid}.json",
        {"xid": xid, "geolocation": {"position": {"lat": 50, "lon": 14}}},
    )
    write_json(paths.photos_geojson_path, {"features": [{"id": xid}]})
    return paths


class PipelineRunDirTests(unittest.TestCase):
    def test_paths_create_run_layout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            paths = PipelinePaths.from_run_dir(Path(tmpdir) / "run")
            paths.create(config={"schema_version": 1})

            self.assertTrue(paths.raw_records_dir.is_dir())
            self.assertTrue(paths.geolocation_ok_dir.is_dir())
            self.assertTrue(paths.llm_batch_results_dir.is_dir())
            self.assertTrue(paths.llm_batch_requests_dir.is_dir())
            self.assertTrue(paths.viewer_data_dir.is_dir())
            self.assertEqual(
                json.loads(paths.config_path.read_text(encoding="utf-8")),
                {"schema_version": 1},
            )

    def test_copy_current_output_snapshot(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "output"
            write_json(output / "available_record_ids.json", ["A1"])
            write_json(output / "missing_details_xids.json", ["A1"])
            write_json(output / "batches.json", {"batches/job1": {"state": "done"}})
            write_json(output / "prompts.json", {"prompt": "text"})
            write_json(output / "batch_results" / "batches_job1.jsonl", {"ok": True})
            (output / "batch_request_1.jsonl").write_text(
                '{"key":"A1"}\n',
                encoding="utf-8",
            )
            write_json(output / "raw_records" / "A1.json", {"xid": "A1"})
            write_json(output / "geolocation" / "ok" / "A1.json", {"xid": "A1"})

            paths = PipelinePaths.from_run_dir(root / "run")
            paths.copy_current_output_snapshot(output_dir=output)

            self.assertTrue(paths.available_record_ids_path.exists())
            self.assertTrue(paths.missing_details_xids_path.exists())
            self.assertTrue(paths.llm_batches_path.exists())
            self.assertTrue(paths.llm_prompts_path.exists())
            self.assertTrue((paths.llm_batch_results_dir / "batches_job1.jsonl").exists())
            self.assertTrue((paths.llm_batch_requests_dir / "batch_request_1.jsonl").exists())
            self.assertTrue((paths.raw_records_dir / "A1.json").exists())
            self.assertTrue((paths.geolocation_ok_dir / "A1.json").exists())

    def test_derive_snapshot_rebuilds_no_network_outputs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            paths = PipelinePaths.from_run_dir(Path(tmpdir) / "run")
            paths.create(config={"schema_version": 1})
            write_json(
                paths.raw_records_dir / "A1.json",
                {
                    "xid": "A1",
                    "obsah": "Dům čp. 12",
                    "rejstříkové záznamy": [
                        {"typ": "Místo", "obsah": "Praha"},
                        {"typ": "Dílo", "obsah": "čp. 12"},
                    ],
                },
            )
            write_json(
                paths.geolocation_ok_dir / "A1.json",
                {
                    "xid": "A1",
                    "typ záznamu": "Archiválie",
                    "druh": "fotografie",
                    "obsah": "Dům čp. 12",
                    "datace": "1900",
                    "zobrazeno": "1",
                    "signatura": "SIG",
                    "autor": "Autor",
                    "poznámka": "",
                    "scan_count": 1,
                    "scan_previews": ["https://example.test/p.jpg"],
                    "scan_zoomify_paths": ["https://example.test/z"],
                    "geolocation": {
                        "position": {"lon": 14.0, "lat": 50.0},
                        "type": "regional.address",
                        "endpoint": "geocode",
                    },
                },
            )

            result = derive_snapshot(paths.root)

            self.assertEqual(result["records_with_places"], 1)
            self.assertEqual(result["exported_records"], 1)
            self.assertEqual(result["geojson_features"], 1)
            self.assertTrue((paths.filter_dir / "records_with_cp.json").exists())
            self.assertTrue(paths.photos_csv_path.exists())
            self.assertTrue(paths.photos_geojson_path.exists())
            self.assertTrue(paths.manifest_path.exists())

            with paths.photos_csv_path.open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["xid"], "A1")

            geojson = json.loads(paths.photos_geojson_path.read_text(encoding="utf-8"))
            self.assertEqual(geojson["features"][0]["properties"]["id"], "A1")

            manifest = json.loads(paths.manifest_path.read_text(encoding="utf-8"))
            artifact_paths = [item["path"] for item in manifest["artifacts"]]
            self.assertIn("collect/available_record_ids.json", artifact_paths)
            self.assertIn("collect/missing_details_xids.json", artifact_paths)
            self.assertIn("geolocation/llm/batches.json", artifact_paths)
            self.assertIn("geolocation/llm/prompts.json", artifact_paths)
            self.assertIn("export/old_prague_photos.csv", artifact_paths)
            self.assertNotIn("output/old_prague_photos.csv", artifact_paths)

    def test_copy_current_output_refuses_nonempty_run_directory(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = PipelinePaths.from_run_dir(root / "run")
            paths.root.mkdir()
            (paths.root / "keep.txt").write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(FileExistsError, "nonempty run directory"):
                paths.copy_current_output_snapshot(output_dir=root / "output")

            self.assertEqual(
                (paths.root / "keep.txt").read_text(encoding="utf-8"),
                "keep",
            )

    def test_publish_snapshot_preserves_legacy_records_and_viewer_features(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = PipelinePaths.from_run_dir(root / "run")
            paths.create(config={"schema_version": 1})
            write_json(paths.raw_records_dir / "new.json", {"xid": "new"})
            write_json(
                paths.geolocation_ok_dir / "new.json",
                {"xid": "new", "geolocation": {"position": {"lat": 50, "lon": 14}}},
            )
            write_json(paths.photos_geojson_path, {"features": [{"id": "new"}]})
            paths.photos_csv_path.write_text("xid\nnew\n", encoding="utf-8")
            write_json(paths.available_record_ids_path, ["new"])
            write_json(paths.llm_batches_path, {"new": {"state": "pending"}})
            paths.failed_xids_path.write_text(
                '{"xid":"new","error":"new attempt"}\n',
                encoding="utf-8",
            )

            output = root / "output"
            write_json(output / "raw_records" / "stale.json", {"xid": "stale"})
            write_json(output / "geolocation" / "ok" / "stale.json", {"xid": "stale"})
            write_json(output / "missing_details_xids.json", ["stale"])
            write_json(output / "available_record_ids.json", ["stale"])
            write_json(output / "batches.json", {"stale": True})
            (output / "failed_xids.jsonl").write_text(
                '{"xid":"stale","error":"old attempt"}\n',
                encoding="utf-8",
            )
            published = root / "published" / "photos.geojson"
            write_json(published, {"features": [{"id": "stale"}]})

            paths.publish_current_output_snapshot(
                output_dir=output,
                photos_geojson_path=published,
            )

            self.assertTrue((output / "raw_records" / "stale.json").exists())
            self.assertTrue((output / "raw_records" / "new.json").exists())
            self.assertTrue((output / "geolocation" / "ok" / "stale.json").exists())
            self.assertTrue((output / "geolocation" / "ok" / "new.json").exists())
            self.assertTrue((output / "missing_details_xids.json").exists())
            self.assertEqual(
                json.loads((output / "available_record_ids.json").read_text()),
                ["stale", "new"],
            )
            self.assertEqual(
                set(json.loads((output / "batches.json").read_text())),
                {"stale", "new"},
            )
            self.assertEqual(
                (output / "failed_xids.jsonl").read_text(encoding="utf-8").splitlines(),
                [
                    '{"xid":"stale","error":"old attempt"}',
                    '{"xid":"new","error":"new attempt"}',
                ],
            )
            self.assertEqual(
                json.loads(published.read_text(encoding="utf-8")),
                {"features": [{"id": "new"}, {"id": "stale"}]},
            )

    def test_publish_snapshot_rejects_corrupt_records_before_staging(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = PipelinePaths.from_run_dir(root / "run")
            paths.create(config={"schema_version": 1})
            (paths.raw_records_dir / "A1.json").write_text(
                '{"xid":',
                encoding="utf-8",
            )
            write_json(
                paths.geolocation_ok_dir / "A1.json",
                {"xid": "A1", "geolocation": {"position": {"lat": 50, "lon": 14}}},
            )
            write_json(paths.photos_geojson_path, {"features": [{"id": "A1"}]})

            with self.assertRaisesRegex(ValueError, "Invalid raw record JSON"):
                paths.publish_current_output_snapshot(
                    output_dir=root / "output",
                    photos_geojson_path=root / "published.geojson",
                )

            self.assertFalse((root / "output").exists())

    def test_publish_snapshot_rejects_viewer_feature_without_geolocation(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = make_publishable_paths(root)
            write_json(paths.photos_geojson_path, {"features": [{"id": "UNKNOWN"}]})

            with self.assertRaisesRegex(ValueError, "no matching geolocation"):
                paths.publish_current_output_snapshot(
                    output_dir=root / "output",
                    photos_geojson_path=root / "published.geojson",
                )

            self.assertFalse((root / "output").exists())

    def test_failure_ledger_merge_preserves_repeated_event_order(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            target = root / "published.jsonl"
            source = root / "run.jsonl"
            failure = '{"xid":"X1","error":"timeout"}'
            resolution = '{"xid":"X1","resolved":true}'
            target.write_text(f"{failure}\n{resolution}\n", encoding="utf-8")
            source.write_text(
                f"{failure}\n{resolution}\n{failure}\n{resolution}\n",
                encoding="utf-8",
            )

            PipelinePaths._merge_jsonl_file(source, target)

            self.assertEqual(
                target.read_text(encoding="utf-8").splitlines(),
                [failure, resolution, failure, resolution],
            )

    def test_publish_deep_merges_matching_record_objects(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = make_publishable_paths(root)
            write_json(
                paths.raw_records_dir / "A1.json",
                {
                    "xid": "A1",
                    "description": "current",
                    "metadata": {"changed": "current"},
                },
            )
            write_json(
                paths.geolocation_ok_dir / "A1.json",
                {
                    "xid": "A1",
                    "geolocation": {"position": {"lat": 50.5}},
                },
            )
            write_json(
                paths.geolocation_failed_dir / "retry" / "A1.json",
                {
                    "xid": "A1",
                    "llm_error": "current failure",
                    "attempt": {"current": 2},
                },
            )

            output = root / "output"
            write_json(
                output / "raw_records" / "A1.json",
                {
                    "xid": "A1",
                    "author": "preserved",
                    "metadata": {"preserved": True, "changed": "old"},
                },
            )
            write_json(
                output / "geolocation" / "ok" / "A1.json",
                {
                    "xid": "A1",
                    "archive_field": "preserved",
                    "geolocation": {
                        "position": {"lat": 49, "lon": 14.25},
                        "endpoint": "geocode",
                    },
                },
            )
            write_json(
                output / "geolocation" / "failed" / "retry" / "A1.json",
                {
                    "xid": "A1",
                    "failure_source": "preserved",
                    "attempt": {"original": 1},
                },
            )

            paths.publish_current_output_snapshot(
                output_dir=output,
                photos_geojson_path=root / "published.geojson",
            )

            raw = json.loads((output / "raw_records" / "A1.json").read_text())
            self.assertEqual(raw["author"], "preserved")
            self.assertEqual(raw["description"], "current")
            self.assertEqual(
                raw["metadata"],
                {"preserved": True, "changed": "current"},
            )
            geolocated = json.loads(
                (output / "geolocation" / "ok" / "A1.json").read_text()
            )
            self.assertEqual(geolocated["archive_field"], "preserved")
            self.assertEqual(
                geolocated["geolocation"],
                {
                    "position": {"lat": 50.5, "lon": 14.25},
                    "endpoint": "geocode",
                },
            )
            failed = json.loads(
                (
                    output
                    / "geolocation"
                    / "failed"
                    / "retry"
                    / "A1.json"
                ).read_text()
            )
            self.assertEqual(failed["failure_source"], "preserved")
            self.assertEqual(failed["llm_error"], "current failure")
            self.assertEqual(failed["attempt"], {"original": 1, "current": 2})

    def test_publish_rejects_differing_same_name_batch_result(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = make_publishable_paths(root)
            result_name = "batches_job1.jsonl"
            (paths.llm_batch_results_dir / result_name).write_text(
                '{"key":"A1","response":"incoming"}\n',
                encoding="utf-8",
            )
            output = root / "output"
            existing = output / "batch_results" / result_name
            existing.parent.mkdir(parents=True)
            existing.write_text(
                '{"key":"A1","response":"published"}\n',
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "immutable Gemini artifact"):
                paths.publish_current_output_snapshot(
                    output_dir=output,
                    photos_geojson_path=root / "published.geojson",
                )

            self.assertIn("published", existing.read_text(encoding="utf-8"))
            self.assertFalse((root / "published.geojson").exists())

    def test_publish_rejects_differing_same_name_batch_request(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = make_publishable_paths(root)
            request_name = "batch_request_same.jsonl"
            (paths.llm_batch_requests_dir / request_name).write_text(
                '{"key":"A1","request":"incoming"}\n',
                encoding="utf-8",
            )
            output = root / "output"
            output.mkdir()
            existing = output / request_name
            existing.write_text(
                '{"key":"A1","request":"published"}\n',
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "immutable Gemini artifact"):
                paths.publish_current_output_snapshot(
                    output_dir=output,
                    photos_geojson_path=root / "published.geojson",
                )

            self.assertIn("published", existing.read_text(encoding="utf-8"))
            self.assertFalse((root / "published.geojson").exists())

    def test_publish_accepts_identical_same_name_gemini_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = make_publishable_paths(root)
            result_name = "batches_job1.jsonl"
            request_name = "batch_request_same.jsonl"
            result_payload = '{"key":"A1","response":"same"}\n'
            request_payload = '{"key":"A1","request":"same"}\n'
            (paths.llm_batch_results_dir / result_name).write_text(
                result_payload,
                encoding="utf-8",
            )
            (paths.llm_batch_requests_dir / request_name).write_text(
                request_payload,
                encoding="utf-8",
            )
            output = root / "output"
            (output / "batch_results").mkdir(parents=True)
            (output / "batch_results" / result_name).write_text(
                result_payload,
                encoding="utf-8",
            )
            (output / request_name).write_text(request_payload, encoding="utf-8")

            paths.publish_current_output_snapshot(
                output_dir=output,
                photos_geojson_path=root / "published.geojson",
            )

            self.assertEqual(
                (output / "batch_results" / result_name).read_text(encoding="utf-8"),
                result_payload,
            )
            self.assertEqual(
                (output / request_name).read_text(encoding="utf-8"),
                request_payload,
            )

    def test_publish_snapshot_rolls_back_when_the_live_swap_fails(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = PipelinePaths.from_run_dir(root / "run")
            paths.create(config={"schema_version": 1})
            write_json(paths.raw_records_dir / "new.json", {"xid": "new"})
            write_json(
                paths.geolocation_ok_dir / "new.json",
                {"xid": "new", "geolocation": {"position": {"lat": 50, "lon": 14}}},
            )
            write_json(paths.photos_geojson_path, {"features": [{"id": "new"}]})
            paths.photos_csv_path.write_text("xid\nnew\n", encoding="utf-8")

            output = root / "output"
            write_json(output / "raw_records" / "old.json", {"xid": "old"})
            published = root / "published" / "photos.geojson"
            write_json(published, {"features": [{"id": "old"}]})
            real_replace = os.replace

            def fail_photo_swap(source: Path, target: Path) -> None:
                if Path(target) == published and ".publish-" in Path(source).name:
                    raise OSError("simulated viewer-data swap failure")
                real_replace(source, target)

            with patch("src.pipeline.paths.os.replace", side_effect=fail_photo_swap):
                with self.assertRaisesRegex(OSError, "simulated viewer-data"):
                    paths.publish_current_output_snapshot(
                        output_dir=output,
                        photos_geojson_path=published,
                    )

            self.assertTrue((output / "raw_records" / "old.json").exists())
            self.assertFalse((output / "raw_records" / "new.json").exists())
            self.assertEqual(
                json.loads(published.read_text(encoding="utf-8")),
                {"features": [{"id": "old"}]},
            )

    def test_publish_snapshot_retains_backups_when_rollback_restore_fails(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = make_publishable_paths(root, xid="new")
            output = root / "output"
            write_json(output / "raw_records" / "old.json", {"xid": "old"})
            published = root / "published" / "photos.geojson"
            write_json(published, {"features": [{"id": "old"}]})
            real_replace = os.replace

            def fail_photo_swap_and_restore(source: Path, target: Path) -> None:
                source_path = Path(source)
                if Path(target) == published and ".publish-" in source_path.name:
                    raise OSError("simulated viewer-data swap failure")
                if Path(target) == published and ".backup-" in source_path.name:
                    raise OSError("simulated viewer-data restoration failure")
                real_replace(source, target)

            with patch(
                "src.pipeline.paths.os.replace",
                side_effect=fail_photo_swap_and_restore,
            ):
                with self.assertRaisesRegex(OSError, "restoration failure"):
                    paths.publish_current_output_snapshot(
                        output_dir=output,
                        photos_geojson_path=published,
                    )

            output_backups = sorted(root.glob(".output.backup-*"))
            photo_backups = sorted(published.parent.glob(".photos.geojson.backup-*"))
            self.assertEqual(len(output_backups), 1)
            self.assertEqual(len(photo_backups), 1)
            self.assertEqual(list(root.glob(".output.publish-*")), [])
            self.assertEqual(
                list(published.parent.glob(".photos.geojson.publish-*")),
                [],
            )

            recovered_output = root / "recovered-output"
            recovered_photo = root / "recovered-photos.geojson"
            real_replace(output_backups[0], recovered_output)
            real_replace(photo_backups[0], recovered_photo)
            self.assertTrue((recovered_output / "raw_records" / "old.json").exists())
            self.assertEqual(
                json.loads(recovered_photo.read_text(encoding="utf-8")),
                {"features": [{"id": "old"}]},
            )

    def test_derive_snapshot_carries_published_series_into_fresh_run(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            paths = PipelinePaths.from_run_dir(root / "run")
            paths.create(config={"schema_version": 1})
            write_json(
                paths.raw_records_dir / "A1.json",
                {
                    "xid": "A1",
                    "obsah": "Changed metadata",
                    "rejstříkové záznamy": [{"typ": "Místo", "obsah": "Praha"}],
                },
            )
            write_json(
                paths.geolocation_ok_dir / "A1.json",
                {
                    "xid": "A1",
                    "obsah": "Changed metadata",
                    "autor": "Autor",
                    "datace": "1901",
                    "geolocation": {
                        "position": {"lon": 14.0, "lat": 50.0},
                        "type": "regional.address",
                        "endpoint": "geocode",
                    },
                },
            )
            published = root / "published.geojson"
            write_json(
                published,
                {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": [14, 50]},
                            "properties": {"id": "A1", "group_id": "series_stable"},
                        }
                    ],
                },
            )

            derive_snapshot(paths.root, existing_groups_path=published)

            geojson = json.loads(paths.photos_geojson_path.read_text(encoding="utf-8"))
            self.assertEqual(
                geojson["features"][0]["properties"]["group_id"],
                "series_stable",
            )


if __name__ == "__main__":
    unittest.main()
