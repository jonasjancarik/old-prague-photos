import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
from unittest.mock import patch

from src.pipeline import batch_geolocate


class BatchGeolocateTests(unittest.TestCase):
    def test_process_results_does_not_skip_failed_records_in_current_batch(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "filtered"
            output_dir = root / "geolocation" / "ok"
            failed_base = root / "geolocation" / "failed"
            failed_cp_dir = failed_base / "records_with_cp"
            batch_results_dir = root / "batch_results"
            filtered_dir.mkdir(parents=True)
            failed_cp_dir.mkdir(parents=True)
            batch_results_dir.mkdir(parents=True)

            record = {
                "xid": "X1",
                "obsah": "Test",
                "rejstříkové záznamy": [],
            }
            (filtered_dir / "records_without_cp.json").write_text(
                json.dumps([]),
                encoding="utf-8",
            )
            (failed_cp_dir / "X1.json").write_text(
                json.dumps(record),
                encoding="utf-8",
            )

            job_name = "batches/job1"
            result_path = batch_results_dir / "batches_job1.jsonl"
            result_path.write_text(
                json.dumps(
                    {
                        "key": "X1",
                        "response": {
                            "candidates": [
                                {
                                    "content": {
                                        "parts": [
                                            {
                                                "text": json.dumps(
                                                    {
                                                        "extraction": {
                                                            "confidence": "high",
                                                        },
                                                        "suggested_addresses": [
                                                            "Staroměstské náměstí, Praha",
                                                        ],
                                                    }
                                                )
                                            }
                                        ]
                                    }
                                }
                            ]
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            manager = batch_geolocate.BatchManager.__new__(batch_geolocate.BatchManager)
            manager.batches = {
                job_name: {
                    "state": "JOB_STATE_SUCCEEDED",
                    "record_ids": ["X1"],
                }
            }
            manager.model = "models/test"
            manager.prompt_hash = "prompt"
            manager.batch_results_dir = batch_results_dir
            manager.input_records_dir = filtered_dir
            manager.output_dir = output_dir
            manager.failed_base_dir = failed_base
            manager.failed_dir = failed_base / "records_without_cp_llm"

            with patch.object(manager, "check_status"), patch.object(
                manager,
                "_save_batches",
            ), patch(
                "src.pipeline.batch_geolocate.geocode_with_mapy_cz",
                return_value={"position": {"lat": 50.0, "lon": 14.0}},
            ):
                manager.process_results(reprocess=False)

            output_path = output_dir / "X1.json"
            self.assertTrue(output_path.exists())
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertTrue(payload["geolocation"]["llm_generated"])

    def test_submit_uses_custom_batch_request_and_metadata_paths(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "run" / "filter"
            batch_requests_dir = root / "run" / "geolocation" / "llm" / "batch_requests"
            batches_file = root / "run" / "geolocation" / "llm" / "batches.json"
            filtered_dir.mkdir(parents=True)
            (filtered_dir / "records_without_cp.json").write_text(
                json.dumps(
                    [
                        {
                            "xid": "X1",
                            "obsah": "Test",
                            "datace": "1900",
                            "rejstříkové záznamy": [],
                        }
                    ]
                ),
                encoding="utf-8",
            )

            uploaded: dict[str, str] = {}

            class FakeFiles:
                def upload(self, file, config):  # type: ignore[no-untyped-def]
                    uploaded["file"] = file
                    return SimpleNamespace(name="files/input")

            class FakeBatches:
                def create(self, model, src, config):  # type: ignore[no-untyped-def]
                    return SimpleNamespace(
                        name="batches/job1",
                        display_name="job",
                        state=SimpleNamespace(name="JOB_STATE_PENDING"),
                    )

            manager = batch_geolocate.BatchManager.__new__(batch_geolocate.BatchManager)
            manager.batches = {}
            manager.batches_file = batches_file
            manager.batch_results_dir = root / "run" / "geolocation" / "llm" / "batch_results"
            manager.batch_requests_dir = batch_requests_dir
            manager.input_records_dir = filtered_dir
            manager.output_dir = root / "run" / "geolocation" / "ok"
            manager.failed_base_dir = root / "run" / "geolocation" / "failed"
            manager.failed_dir = manager.failed_base_dir / "records_without_cp_llm"
            manager.model = "models/test"
            manager.prompt_hash = "prompt"
            manager.client = SimpleNamespace(files=FakeFiles(), batches=FakeBatches())

            manager.submit(limit=1)

            request_files = list(batch_requests_dir.glob("batch_request_*.jsonl"))
            self.assertEqual(len(request_files), 1)
            self.assertEqual(uploaded["file"], str(request_files[0]))
            batches = json.loads(batches_file.read_text(encoding="utf-8"))
            self.assertEqual(batches["batches/job1"]["record_ids"], ["X1"])
            self.assertEqual(batches["batches/job1"]["input_file"], str(request_files[0]))


if __name__ == "__main__":
    unittest.main()
