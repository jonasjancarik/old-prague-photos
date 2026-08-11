import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
from unittest.mock import patch

from src.pipeline import batch_geolocate


class BatchGeolocateTests(unittest.TestCase):
    @staticmethod
    def _manager(root: Path, filtered_dir: Path):
        manager = batch_geolocate.BatchManager.__new__(batch_geolocate.BatchManager)
        manager.batches_file = root / "batches.json"
        manager.batch_results_dir = root / "batch_results"
        manager.batch_requests_dir = root / "batch_requests"
        manager.input_records_dir = filtered_dir
        manager.output_dir = root / "geolocation" / "ok"
        manager.failed_base_dir = root / "geolocation" / "failed"
        manager.failed_dir = manager.failed_base_dir / "records_without_cp_llm"
        manager.model = "models/test"
        manager.prompt_hash = "prompt"
        return manager

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

    def test_submit_skips_ids_reserved_by_unfinished_legacy_batch(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "filtered"
            filtered_dir.mkdir()
            (filtered_dir / "records_without_cp.json").write_text(
                json.dumps(
                    [
                        {"xid": "X1", "obsah": "Reserved", "rejstříkové záznamy": []},
                        {"xid": "X2", "obsah": "New", "rejstříkové záznamy": []},
                    ]
                ),
                encoding="utf-8",
            )
            manager = self._manager(root, filtered_dir)
            manager.batch_requests_dir.mkdir()
            legacy_request = manager.batch_requests_dir / "legacy.jsonl"
            legacy_request.write_text('{"key":"X1"}\n', encoding="utf-8")
            manager.batches = {
                "batches/legacy": {
                    "state": "JOB_STATE_PENDING",
                    "input_file": str(legacy_request),
                }
            }

            class FakeFiles:
                def upload(self, file, config):  # type: ignore[no-untyped-def]
                    return SimpleNamespace(name="files/input")

            class FakeBatches:
                def create(self, model, src, config):  # type: ignore[no-untyped-def]
                    return SimpleNamespace(
                        name="batches/new",
                        display_name="new",
                        state=SimpleNamespace(name="JOB_STATE_PENDING"),
                    )

            manager.client = SimpleNamespace(files=FakeFiles(), batches=FakeBatches())
            manager.submit()

            request_files = sorted(manager.batch_requests_dir.glob("batch_request_*.jsonl"))
            self.assertEqual(len(request_files), 1)
            request = json.loads(request_files[0].read_text(encoding="utf-8"))
            self.assertEqual(request["key"], "X2")

    def test_partial_batch_result_is_not_marked_processed(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "filtered"
            filtered_dir.mkdir()
            (filtered_dir / "records_without_cp.json").write_text("[]", encoding="utf-8")
            manager = self._manager(root, filtered_dir)
            manager.batch_results_dir.mkdir()
            job_name = "batches/job1"
            manager.batches = {
                job_name: {
                    "state": "JOB_STATE_SUCCEEDED",
                    "record_ids": ["X1", "X2"],
                }
            }
            result_path = manager._results_path(job_name)
            result_path.write_text('{"key":"X1","error":"failed"}\n', encoding="utf-8")

            with patch.object(manager, "check_status"), patch.object(
                manager,
                "_save_batches",
            ):
                with self.assertRaisesRegex(ValueError, "do not match its request"):
                    manager.process_results()

            self.assertNotIn("processed_at", manager.batches[job_name])

    def test_process_results_refuses_to_complete_without_original_record(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "filtered"
            filtered_dir.mkdir()
            (filtered_dir / "records_without_cp.json").write_text(
                "[]",
                encoding="utf-8",
            )
            manager = self._manager(root, filtered_dir)
            manager.batch_results_dir.mkdir()
            job_name = "batches/job1"
            manager.batches = {
                job_name: {
                    "state": "JOB_STATE_SUCCEEDED",
                    "record_ids": ["X1"],
                }
            }
            manager._results_path(job_name).write_text(
                '{"key":"X1","error":"remote failure"}\n',
                encoding="utf-8",
            )

            with patch.object(manager, "check_status"), patch.object(
                manager,
                "_save_batches",
            ):
                with self.assertRaisesRegex(ValueError, "original records are missing"):
                    manager.process_results()

            self.assertNotIn("processed_at", manager.batches[job_name])

    def test_legacy_job_prefers_run_local_request_snapshot(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "filtered"
            manager = self._manager(root, filtered_dir)
            manager.batch_requests_dir.mkdir()
            external_dir = root / "old-output"
            external_dir.mkdir()
            external_request = external_dir / "request.jsonl"
            external_request.write_text('{"key":"OUTSIDE"}\n', encoding="utf-8")
            local_request = manager.batch_requests_dir / external_request.name
            local_request.write_text('{"key":"LOCAL"}\n', encoding="utf-8")

            self.assertEqual(
                manager._record_ids_for_job({"input_file": str(external_request)}),
                {"LOCAL"},
            )

    def test_submit_failure_keeps_local_intent_reserved(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "filtered"
            filtered_dir.mkdir()
            (filtered_dir / "records_without_cp.json").write_text(
                json.dumps(
                    [{"xid": "X1", "obsah": "Test", "rejstříkové záznamy": []}]
                ),
                encoding="utf-8",
            )
            manager = self._manager(root, filtered_dir)
            manager.batches = {}

            class FailingFiles:
                def upload(self, file, config):  # type: ignore[no-untyped-def]
                    raise RuntimeError("simulated upload failure")

            manager.client = SimpleNamespace(files=FailingFiles(), batches=None)

            with self.assertRaisesRegex(RuntimeError, "simulated upload failure"):
                manager.submit()

            self.assertEqual(len(manager.batches), 1)
            intent = next(iter(manager.batches.values()))
            self.assertEqual(intent["state"], "LOCAL_REQUEST_READY")
            self.assertEqual(intent["record_ids"], ["X1"])
            self.assertEqual(manager._reserved_record_ids(), {"X1"})

    def test_explicit_retry_modes_bypass_failures_but_not_success_or_reservation(
        self,
    ) -> None:
        cases = (
            ("failed_cp", "records_with_cp", {"include_failed_cp": True}),
            (
                "missing_content",
                "records_without_cp_llm",
                {"retry_missing_content": True},
            ),
        )
        for label, failed_subdir, submit_kwargs in cases:
            with self.subTest(label=label), TemporaryDirectory() as tmpdir:
                root = Path(tmpdir)
                filtered_dir = root / "filtered"
                failed_dir = root / "geolocation" / "failed" / failed_subdir
                output_dir = root / "geolocation" / "ok"
                filtered_dir.mkdir(parents=True)
                failed_dir.mkdir(parents=True)
                output_dir.mkdir(parents=True)
                (filtered_dir / "records_without_cp.json").write_text(
                    "[]", encoding="utf-8"
                )
                for xid in ("X1", "X2", "X3"):
                    record = {
                        "xid": xid,
                        "obsah": "Test",
                        "rejstříkové záznamy": [],
                    }
                    if label == "missing_content":
                        record["llm_error"] = "missing content parts"
                    (failed_dir / f"{xid}.json").write_text(
                        json.dumps(record), encoding="utf-8"
                    )
                (output_dir / "X3.json").write_text(
                    json.dumps({"xid": "X3", "geolocation": {}}),
                    encoding="utf-8",
                )

                manager = self._manager(root, filtered_dir)
                manager.batches = {
                    "batches/existing": {
                        "state": "JOB_STATE_PENDING",
                        "record_ids": ["X2"],
                    }
                }

                class FakeFiles:
                    def upload(self, file, config):  # type: ignore[no-untyped-def]
                        return SimpleNamespace(name="files/input")

                class FakeBatches:
                    def create(self, model, src, config):  # type: ignore[no-untyped-def]
                        return SimpleNamespace(
                            name="batches/new",
                            display_name=config.display_name,
                            state=SimpleNamespace(name="JOB_STATE_PENDING"),
                        )

                manager.client = SimpleNamespace(
                    files=FakeFiles(), batches=FakeBatches()
                )
                manager.submit(**submit_kwargs)

                self.assertEqual(manager.batches["batches/new"]["record_ids"], ["X1"])
                request_path = Path(manager.batches["batches/new"]["input_file"])
                request = json.loads(request_path.read_text(encoding="utf-8"))
                self.assertEqual(request["key"], "X1")

    def test_request_ready_intent_resumes_from_saved_request(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "filtered"
            filtered_dir.mkdir()
            (filtered_dir / "records_without_cp.json").write_text(
                json.dumps(
                    [{"xid": "X1", "obsah": "Test", "rejstříkové záznamy": []}]
                ),
                encoding="utf-8",
            )
            manager = self._manager(root, filtered_dir)
            manager.batches = {}

            class FailingFiles:
                def upload(self, file, config):  # type: ignore[no-untyped-def]
                    raise RuntimeError("upload interrupted")

            manager.client = SimpleNamespace(files=FailingFiles(), batches=None)
            with self.assertRaisesRegex(RuntimeError, "upload interrupted"):
                manager.submit()

            intent_name = next(iter(manager.batches))
            saved_request = manager.batches[intent_name]["input_file"]
            uploaded: list[str] = []

            class SuccessfulFiles:
                def upload(self, file, config):  # type: ignore[no-untyped-def]
                    uploaded.append(file)
                    return SimpleNamespace(name="files/input")

            class SuccessfulBatches:
                def create(self, model, src, config):  # type: ignore[no-untyped-def]
                    return SimpleNamespace(
                        name="batches/job1",
                        display_name=config.display_name,
                        state=SimpleNamespace(name="JOB_STATE_PENDING"),
                    )

            manager.client = SimpleNamespace(
                files=SuccessfulFiles(), batches=SuccessfulBatches()
            )
            manager.submit()

            self.assertEqual(uploaded, [saved_request])
            self.assertNotIn(intent_name, manager.batches)
            self.assertEqual(manager.batches["batches/job1"]["record_ids"], ["X1"])

    def test_create_ambiguity_requires_remote_job_reconciliation(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            filtered_dir = root / "filtered"
            filtered_dir.mkdir()
            (filtered_dir / "records_without_cp.json").write_text(
                json.dumps(
                    [{"xid": "X1", "obsah": "Test", "rejstříkové záznamy": []}]
                ),
                encoding="utf-8",
            )
            manager = self._manager(root, filtered_dir)
            manager.batches = {}

            class SuccessfulFiles:
                def upload(self, file, config):  # type: ignore[no-untyped-def]
                    return SimpleNamespace(name="files/input")

            class AmbiguousBatches:
                def create(self, model, src, config):  # type: ignore[no-untyped-def]
                    raise RuntimeError("create response lost")

            manager.client = SimpleNamespace(
                files=SuccessfulFiles(), batches=AmbiguousBatches()
            )
            with self.assertRaisesRegex(RuntimeError, "create response lost"):
                manager.submit()

            intent_name = next(iter(manager.batches))
            intent = manager.batches[intent_name]
            self.assertEqual(intent["state"], "LOCAL_CREATE_PENDING")
            self.assertEqual(intent["phase"], "create_pending")
            self.assertEqual(intent["uploaded_file"], "files/input")
            self.assertEqual(manager._reserved_record_ids(), {"X1"})

            class ReconciliationBatches:
                def get(self, name):  # type: ignore[no-untyped-def]
                    return SimpleNamespace(
                        name=name,
                        display_name=intent["display_name"],
                        state=SimpleNamespace(name="JOB_STATE_PENDING"),
                    )

            manager.client = SimpleNamespace(batches=ReconciliationBatches())
            manager.reconcile_local_intent(intent_name, "batches/job1")

            self.assertNotIn(intent_name, manager.batches)
            reconciled = manager.batches["batches/job1"]
            self.assertEqual(reconciled["record_ids"], ["X1"])
            self.assertIn("reconciled_at", reconciled)

    def test_process_results_rejects_noncanonical_result_keys(self) -> None:
        for key in (1, " X1 "):
            with self.subTest(key=key), TemporaryDirectory() as tmpdir:
                root = Path(tmpdir)
                filtered_dir = root / "filtered"
                filtered_dir.mkdir()
                (filtered_dir / "records_without_cp.json").write_text(
                    "[]", encoding="utf-8"
                )
                manager = self._manager(root, filtered_dir)
                manager.batch_results_dir.mkdir()
                job_name = "batches/job1"
                manager.batches = {
                    job_name: {
                        "state": "JOB_STATE_SUCCEEDED",
                        "record_ids": ["X1"],
                    }
                }
                manager._results_path(job_name).write_text(
                    json.dumps({"key": key, "error": "failed"}) + "\n",
                    encoding="utf-8",
                )

                with patch.object(manager, "check_status"), patch.object(
                    manager, "_save_batches"
                ):
                    with self.assertRaisesRegex(ValueError, "noncanonical record key"):
                        manager.process_results()

                self.assertNotIn("processed_at", manager.batches[job_name])


if __name__ == "__main__":
    unittest.main()
