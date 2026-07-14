import csv
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from src.pipeline.derive import derive_snapshot
from src.pipeline.paths import PipelinePaths


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


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
