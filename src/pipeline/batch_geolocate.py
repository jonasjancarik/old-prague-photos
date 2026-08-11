import json
import os
import logging
import hashlib
from dataclasses import asdict
from typing import Dict, Optional
from datetime import datetime
from pathlib import Path
from google import genai
from google.genai import types
from dotenv import load_dotenv

from src.pipeline.atomic_io import (
    atomic_write_bytes,
    atomic_write_json,
    atomic_write_text,
)

# Re-use utilities from the Mapy.cz geolocation pipeline.
from src.pipeline.geolocate import (
    COMBINED_PROMPT_TEMPLATE,
    geocode_with_mapy_cz,
    save_to_file,
    LocationInfo,
    list_directory,
    get_prompt_hash,
    save_prompt,
)

load_dotenv()

BATCHES_FILE = "output/batches.json"
BATCH_RESULTS_DIR = "output/batch_results"
INPUT_RECORDS_DIR = "output/filtered"
OUTPUT_DIR = "output/geolocation/ok"
FAILED_BASE_DIR = "output/geolocation/failed"
FAILED_DIR = "output/geolocation/failed/records_without_cp_llm"

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


class BatchManager:
    def __init__(
        self,
        *,
        batches_file: str | Path = BATCHES_FILE,
        batch_results_dir: str | Path = BATCH_RESULTS_DIR,
        batch_requests_dir: str | Path = "output",
        input_records_dir: str | Path = INPUT_RECORDS_DIR,
        output_dir: str | Path = OUTPUT_DIR,
        failed_base_dir: str | Path = FAILED_BASE_DIR,
        failed_dir: str | Path | None = None,
        prompts_file: str | Path = "output/prompts.json",
    ):
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            logging.error("GEMINI_API_KEY not found in environment variables.")
            exit(1)
        self.batches_file = Path(batches_file)
        self.batch_results_dir = Path(batch_results_dir)
        self.batch_requests_dir = Path(batch_requests_dir)
        self.input_records_dir = Path(input_records_dir)
        self.output_dir = Path(output_dir)
        self.failed_base_dir = Path(failed_base_dir)
        self.failed_dir = (
            Path(failed_dir)
            if failed_dir
            else self.failed_base_dir / "records_without_cp_llm"
        )
        self.prompts_file = Path(prompts_file)

        self.client = genai.Client(api_key=api_key)
        self.model = os.getenv("LLM_MODEL", "gemini/gemini-3-flash-preview").replace(
            "gemini/", "models/"
        )
        self.prompt_hash = get_prompt_hash(COMBINED_PROMPT_TEMPLATE)
        save_prompt(
            self.prompt_hash,
            COMBINED_PROMPT_TEMPLATE,
            prompts_file=self.prompts_file,
        )
        self.batches = self._load_batches()
        logging.info(f"BatchManager initialized with model: {self.model}")

    def _load_batches(self) -> Dict:
        if self.batches_file.exists():
            with self.batches_file.open("r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    def _save_batches(self):
        atomic_write_json(self.batches_file, self.batches, indent=2)

    def _record_ids_for_job(self, job_data: dict) -> set[str]:
        stored_ids = {
            str(item).strip()
            for item in (job_data.get("record_ids") or [])
            if str(item).strip()
        }
        if stored_ids:
            return stored_ids

        input_file = job_data.get("input_file")
        if not input_file:
            raise RuntimeError(
                "Cannot safely resume a batch without record_ids or input_file"
            )
        metadata_path = Path(input_file)
        request_path = self.batch_requests_dir / metadata_path.name
        if not request_path.exists():
            request_path = metadata_path
        if not request_path.exists():
            raise RuntimeError(
                f"Cannot safely resume batch; request file is missing: {input_file}"
            )

        recovered: set[str] = set()
        for line_number, line in enumerate(
            request_path.read_text(encoding="utf-8").splitlines(),
            start=1,
        ):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except Exception as exc:
                raise ValueError(
                    f"Invalid batch request JSON at {request_path}:{line_number}: {exc}"
                ) from exc
            key = str(entry.get("key", "")).strip()
            if not key:
                raise ValueError(
                    f"Missing record key at {request_path}:{line_number}"
                )
            if key in recovered:
                raise ValueError(f"Duplicate record key {key!r} in {request_path}")
            recovered.add(key)
        if not recovered:
            raise ValueError(f"Batch request contains no record keys: {request_path}")
        return recovered

    def _reserved_record_ids(self) -> set[str]:
        terminal_without_work = {"JOB_STATE_FAILED", "JOB_STATE_CANCELLED"}
        reserved: set[str] = set()
        for job_data in self.batches.values():
            if "processed_at" in job_data:
                continue
            if job_data.get("state") in terminal_without_work:
                continue
            reserved.update(self._record_ids_for_job(job_data))
        return reserved

    def _request_path_for_intent(self, intent: dict) -> Path:
        input_file = intent.get("input_file")
        if not input_file:
            raise RuntimeError("Local batch intent has no request file")
        metadata_path = Path(input_file)
        request_path = self.batch_requests_dir / metadata_path.name
        if not request_path.exists():
            request_path = metadata_path
        if not request_path.exists():
            raise RuntimeError(
                f"Local batch intent request file is missing: {input_file}"
            )
        expected_sha256 = str(intent.get("request_sha256") or "").strip()
        actual_sha256 = hashlib.sha256(request_path.read_bytes()).hexdigest()
        if expected_sha256 and actual_sha256 != expected_sha256:
            raise RuntimeError(
                "Local batch intent request checksum changed: "
                f"{request_path}"
            )
        return request_path

    def _adopt_remote_job(
        self,
        intent_name: str,
        job,
        *,
        reconciled: bool = False,
    ) -> None:
        intent = self.batches[intent_name]
        metadata = dict(intent)
        metadata.update(
            {
                "name": job.name,
                "display_name": job.display_name,
                "state": job.state.name,
                "phase": "remote_job",
            }
        )
        if reconciled:
            metadata["reconciled_at"] = datetime.now().isoformat()
        if getattr(job, "dest", None) and getattr(job.dest, "file_name", None):
            metadata["output_file"] = job.dest.file_name
        self.batches.pop(intent_name)
        self.batches[job.name] = metadata
        self._save_batches()

    def _submit_local_intent(self, intent_name: str) -> None:
        intent = self.batches[intent_name]
        state = intent.get("state")
        if state == "LOCAL_REQUEST_READY":
            request_path = self._request_path_for_intent(intent)
            logging.info("Uploading saved batch request %s...", request_path)
            uploaded_file = self.client.files.upload(
                file=str(request_path),
                config=types.UploadFileConfig(
                    display_name=request_path.name,
                    mime_type="application/jsonl",
                ),
            )
            intent["uploaded_file"] = uploaded_file.name
            intent["uploaded_at"] = datetime.now().isoformat()
            intent["state"] = "LOCAL_FILE_UPLOADED"
            intent["phase"] = "file_uploaded"
            self._save_batches()
            state = intent["state"]

        if state != "LOCAL_FILE_UPLOADED":
            raise RuntimeError(
                f"Local intent {intent_name} is not safely resumable from {state!r}"
            )

        intent["state"] = "LOCAL_CREATE_PENDING"
        intent["phase"] = "create_pending"
        intent["create_started_at"] = datetime.now().isoformat()
        self._save_batches()

        # Once this call starts, a transport error is ambiguous: the remote job
        # may exist. Keep the reservation until the operator reconciles it by
        # remote job name instead of submitting the records again.
        logging.info("Creating batch job with model %s...", self.model)
        job = self.client.batches.create(
            model=self.model,
            src=intent["uploaded_file"],
            config=types.CreateBatchJobConfig(
                display_name=intent["display_name"]
            ),
        )
        self._adopt_remote_job(intent_name, job)
        logging.info("Batch job created: %s", job.name)

    def _resume_safe_local_intents(self) -> int:
        resumable = [
            name
            for name, data in self.batches.items()
            if name.startswith("local/")
            and data.get("state")
            in {"LOCAL_REQUEST_READY", "LOCAL_FILE_UPLOADED"}
        ]
        for intent_name in sorted(resumable):
            self._submit_local_intent(intent_name)
        return len(resumable)

    def reconcile_local_intent(
        self,
        intent_name: str,
        remote_job_name: str,
    ) -> None:
        """Attach an ambiguous post-create intent to a verified remote job."""
        if intent_name not in self.batches and not intent_name.startswith("local/"):
            intent_name = f"local/{intent_name}"
        intent = self.batches.get(intent_name)
        if not intent or not intent_name.startswith("local/"):
            raise ValueError(f"Unknown local batch intent: {intent_name}")
        if intent.get("state") != "LOCAL_CREATE_PENDING":
            raise ValueError(
                f"Local intent {intent_name} is not awaiting reconciliation"
            )
        if remote_job_name in self.batches:
            raise ValueError(f"Remote batch job is already recorded: {remote_job_name}")

        job = self.client.batches.get(name=remote_job_name)
        if job.name != remote_job_name:
            raise ValueError(
                f"Remote batch identity mismatch: {job.name!r} != {remote_job_name!r}"
            )
        if job.display_name != intent.get("display_name"):
            raise ValueError(
                "Remote batch display name does not match the local intent: "
                f"{job.display_name!r} != {intent.get('display_name')!r}"
            )
        self._adopt_remote_job(intent_name, job, reconciled=True)

    def submit(
        self,
        limit: Optional[int] = None,
        redo_llm: bool = False,
        include_failed_cp: bool = False,
        retry_missing_content: bool = False,
    ):
        """Prepare and submit batch job.

        Args:
            limit: Max records to process (for testing)
            redo_llm: If True, also re-process records that were previously LLM-geolocated
            include_failed_cp: If True, include records that failed direct geocoding
            retry_missing_content: If True, include LLM failures missing content parts
        """
        if self._resume_safe_local_intents():
            return

        records_to_process = []
        record_ids_to_process = set()

        # Get already processed IDs
        geolocated_files = list_directory(self.output_dir)
        geolocation_failed_files = []
        for root, dirs, files in os.walk(self.failed_base_dir):
            for filename in files:
                geolocation_failed_files.append(filename.replace(".json", ""))

        # Check which geolocated records are LLM-generated (for --redo-llm)
        llm_geolocated_ids = set()
        direct_geolocated_ids = set()
        for f in geolocated_files:
            xid = f.replace(".json", "")
            try:
                with (self.output_dir / f).open("r", encoding="utf-8") as file:
                    record = json.load(file)
                    if record.get("geolocation", {}).get("llm_generated"):
                        llm_geolocated_ids.add(xid)
                    else:
                        direct_geolocated_ids.add(xid)
            except Exception:
                direct_geolocated_ids.add(xid)  # Assume direct if can't read

        # Determine which IDs to skip for ordinary selection. Explicit retry
        # modes bypass prior failure files, but never a successful output or an
        # unfinished remote-work reservation.
        if redo_llm:
            # Skip only direct matches and failed, include old LLM records
            processed_ids = direct_geolocated_ids.union(set(geolocation_failed_files))
            logging.info(
                f"--redo-llm: Will re-process {len(llm_geolocated_ids)} old LLM records"
            )
        else:
            # Skip everything already processed
            processed_ids = direct_geolocated_ids.union(llm_geolocated_ids).union(
                set(geolocation_failed_files)
            )
        reserved_ids = self._reserved_record_ids()
        processed_ids.update(reserved_ids)
        explicit_retry_skip_ids = (
            direct_geolocated_ids.union(llm_geolocated_ids).union(reserved_ids)
        )
        if reserved_ids:
            logging.info(
                "Skipping %s records reserved by unfinished batch jobs",
                len(reserved_ids),
            )

        # Load filtered records (records_without_cp and records_with_cp_in_record_obsah)
        filtered_files = list_directory(self.input_records_dir)
        for f in filtered_files:
            # Include both unstructured records AND those with čp. only in description
            if f.endswith(".json") and (
                "records_without_cp" in f or "records_with_cp_in_record_obsah" in f
            ):
                with open(
                    self.input_records_dir / f, "r", encoding="utf-8"
                ) as file:
                    all_records = json.load(file)
                    for record in all_records:
                        xid = record["xid"]
                        if xid in processed_ids or xid in record_ids_to_process:
                            continue
                        records_to_process.append(record)
                        record_ids_to_process.add(xid)

        # Optionally include failed structured records for LLM processing
        if include_failed_cp:
            failed_dirs = [
                self.failed_base_dir / "records_with_cp",
                self.failed_base_dir / "records_with_cp_in_record_obsah",
            ]
            failed_files = []
            for failed_dir in failed_dirs:
                if failed_dir.exists():
                    failed_files.extend(
                        [
                            failed_dir / f
                            for f in list_directory(failed_dir)
                            if f.endswith(".json")
                        ]
                    )
            if failed_files:
                logging.info(
                    "--include-failed-cp: Adding %s failed Mapy.cz records",
                    len(failed_files),
                )
                for filepath in failed_files:
                    with Path(filepath).open("r", encoding="utf-8") as file:
                        record = json.load(file)
                    xid = record["xid"]
                    if xid in explicit_retry_skip_ids or xid in record_ids_to_process:
                        continue
                    records_to_process.append(record)
                    record_ids_to_process.add(xid)

        if retry_missing_content and self.failed_dir.exists():
            retry_errors = {
                "missing candidates",
                "missing content parts",
                "missing text parts",
                "no JSON in response",
            }
            retry_files = [
                f for f in list_directory(self.failed_dir) if f.endswith(".json")
            ]
            retry_count = 0
            for filename in retry_files:
                with (self.failed_dir / filename).open("r", encoding="utf-8") as file:
                    record = json.load(file)
                if record.get("llm_error") not in retry_errors:
                    continue
                xid = record["xid"]
                if xid in explicit_retry_skip_ids or xid in record_ids_to_process:
                    continue
                records_to_process.append(record)
                record_ids_to_process.add(xid)
                retry_count += 1
            if retry_count:
                logging.info(
                    "--retry-missing-content: Adding %s LLM failures", retry_count
                )

        if limit:
            records_to_process = records_to_process[:limit]

        if not records_to_process:
            logging.info("No new records to process.")
            return

        logging.info(f"Preparing batch for {len(records_to_process)} records...")

        # Create JSONL file
        request_lines = []
        for record in records_to_process:
            # Use extraction prompt logic
            obsah = record.get("obsah", "")
            misto_entries = [
                item["obsah"]
                for item in record.get("rejstříkové záznamy", [])
                if item.get("typ", "").lower() == "místo"
            ]
            dilo_entries = [
                item["obsah"]
                for item in record.get("rejstříkové záznamy", [])
                if item.get("typ", "").lower() == "dílo"
            ]
            datace = record.get("datace", "")

            prompt = COMBINED_PROMPT_TEMPLATE.format(
                obsah=obsah,
                misto_entries=misto_entries,
                dilo_entries=dilo_entries,
                datace=datace,
            )

            request = {
                "key": record["xid"],
                "request": {
                    "contents": [{"parts": [{"text": prompt}], "role": "user"}],
                    "generation_config": {
                        "temperature": 1.0,
                        "thinking_config": {"thinking_level": "MEDIUM"},
                    },
                },
            }
            request_lines.append(json.dumps(request, ensure_ascii=False))
        request_payload = "\n".join(request_lines) + "\n"
        request_fingerprint = hashlib.sha256(request_payload.encode("utf-8")).hexdigest()
        batch_path = self.batch_requests_dir / (
            f"batch_request_{request_fingerprint[:16]}.jsonl"
        )
        atomic_write_text(batch_path, request_payload)

        intent_name = f"local/{request_fingerprint[:16]}"
        self.batches[intent_name] = {
            "name": intent_name,
            "state": "LOCAL_REQUEST_READY",
            "created_at": datetime.now().isoformat(),
            "input_file": str(batch_path),
            "request_sha256": request_fingerprint,
            "phase": "request_ready",
            "display_name": f"Geolocation_{request_fingerprint[:16]}",
            "record_ids": sorted(str(record["xid"]) for record in records_to_process),
            "record_count": len(records_to_process),
        }
        self._save_batches()
        self._submit_local_intent(intent_name)

    def check_status(self):
        """Check status of active jobs and update metadata."""
        active_jobs = [
            j
            for j, data in self.batches.items()
            if not j.startswith("local/")
            if data["state"]
            not in ["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED"]
        ]

        if not active_jobs:
            logging.info("No active batch jobs.")
            return

        for job_name in active_jobs:
            job = self.client.batches.get(name=job_name)
            logging.info(f"Job {job_name}: {job.state.name}")
            self.batches[job_name]["state"] = job.state.name
            if job.state.name == "JOB_STATE_SUCCEEDED":
                if job.dest and job.dest.file_name:
                    self.batches[job_name]["output_file"] = job.dest.file_name
                else:
                    logging.warning(
                        f"Job {job_name} succeeded but no output file found in 'dest'"
                    )
            elif job.state.name == "JOB_STATE_FAILED":
                self.batches[job_name]["error"] = str(job.error)

        self._save_batches()

    def _results_path(self, job_name: str) -> Path:
        safe_name = job_name.replace("/", "_")
        return self.batch_results_dir / f"{safe_name}.jsonl"

    def _matches_job_filter(self, job_name: str, job_filter):
        if not job_filter:
            return True
        for item in job_filter:
            if job_name == item or job_name.endswith(f"/{item}"):
                return True
        return False

    def download_results(self, redownload: bool = False, job_filter=None):
        """Check status first, then download batch results."""
        self.check_status()

        completed_jobs = [
            j
            for j, data in self.batches.items()
            if data["state"] == "JOB_STATE_SUCCEEDED"
        ]
        completed_jobs = [
            j for j in completed_jobs if self._matches_job_filter(j, job_filter)
        ]
        if redownload:
            logging.info(
                "--redownload: Will download %s batch jobs", len(completed_jobs)
            )
        else:
            completed_jobs = [
                j for j in completed_jobs if not self._results_path(j).exists()
            ]

        if not completed_jobs:
            logging.info("No completed jobs to download.")
            return

        for job_name in completed_jobs:
            job_data = self.batches[job_name]
            output_file_name = job_data.get("output_file")
            if not output_file_name:
                logging.warning(f"No output file for succeeded job {job_name}")
                continue

            logging.info(f"Downloading results for {job_name}...")
            content = self.client.files.download(file=output_file_name)
            results_path = self._results_path(job_name)
            atomic_write_bytes(results_path, content)
            job_data["downloaded_at"] = datetime.now().isoformat()
            job_data["results_file"] = str(results_path)
            logging.info("Saved batch results to %s", results_path)

        self._save_batches()

    def process_results(self, reprocess: bool = False, job_filter=None):
        """Process downloaded batch results and geocode."""
        self.check_status()

        completed_jobs = [
            j
            for j, data in self.batches.items()
            if data["state"] == "JOB_STATE_SUCCEEDED"
        ]
        if not reprocess:
            completed_jobs = [
                j for j in completed_jobs if "processed_at" not in self.batches[j]
            ]
        completed_jobs = [
            j for j in completed_jobs if self._matches_job_filter(j, job_filter)
        ]
        if reprocess:
            logging.info(
                "--reprocess: Will process %s batch jobs", len(completed_jobs)
            )

        if not completed_jobs:
            logging.info("No completed jobs to process.")
            return

        for job_name in completed_jobs:
            job_data = self.batches[job_name]
            results_path = self._results_path(job_name)
            if not results_path.exists():
                logging.warning(
                    "No downloaded results for %s. Run `collect` first.", job_name
                )
                continue

            with results_path.open("rb") as results_file:
                content = results_file.read()

            # Load all filtered records into a map for fast lookup
            record_map = {}
            filtered_files = list_directory(self.input_records_dir)
            for f in filtered_files:
                # Include records_without_cp AND records_with_cp_in_record_obsah
                if "records_without_cp" in f or "records_with_cp_in_record_obsah" in f:
                    with open(
                        self.input_records_dir / f, "r", encoding="utf-8"
                    ) as file:
                        for r in json.load(file):
                            record_map[r["xid"]] = r

            # Also load from failed directories (for --include-failed-cp batch results)
            for root, dirs, files in os.walk(self.failed_base_dir):
                for filename in files:
                    if filename.endswith(".json"):
                        with open(
                            os.path.join(root, filename), "r", encoding="utf-8"
                        ) as file:
                            r = json.load(file)
                            record_map[r["xid"]] = r

            def mark_failed(xid, reason):
                record = record_map.get(xid)
                if not record:
                    logging.warning(
                        "Could not find original record for %s in memory map", xid
                    )
                    return
                record["llm_error"] = reason
                save_to_file(self.failed_dir, record["xid"], record)

            lines = content.decode("utf-8").splitlines()
            total_lines = len(lines)
            result_entries = []
            for line_number, line in enumerate(lines, start=1):
                if not line.strip():
                    continue
                entry = json.loads(line)
                if not isinstance(entry, dict):
                    raise ValueError(
                        f"Batch result entry must be an object at "
                        f"{results_path}:{line_number}"
                    )
                key = entry.get("key")
                if not isinstance(key, str) or not key or key != key.strip():
                    raise ValueError(
                        f"Batch result has a noncanonical record key at "
                        f"{results_path}:{line_number}: {key!r}"
                    )
                result_entries.append(entry)
            result_keys = [entry["key"] for entry in result_entries]
            if len(result_keys) != len(set(result_keys)):
                raise ValueError(f"Batch result contains duplicate record keys: {results_path}")
            expected_ids = self._record_ids_for_job(job_data)
            if set(result_keys) != expected_ids:
                missing = sorted(expected_ids - set(result_keys))
                unexpected = sorted(set(result_keys) - expected_ids)
                raise ValueError(
                    f"Batch result keys do not match its request for {job_name}: "
                    f"missing={missing[:5]} unexpected={unexpected[:5]}"
                )
            submitted_ids = set(result_keys)
            submitted_ids.update(
                str(item).strip()
                for item in job_data.get("record_ids", [])
                if str(item).strip()
            )

            # Get already geolocated IDs to support resuming. Failed records that are
            # part of this batch must still be processed; they were explicitly retried.
            geolocated_ids = {
                f.replace(".json", "") for f in list_directory(self.output_dir)
            }
            failed_ids = set()
            for root, dirs, files in os.walk(self.failed_base_dir):
                for filename in files:
                    failed_ids.add(filename.replace(".json", ""))

            processed_ids = set()
            if not reprocess:
                processed_ids = geolocated_ids.union(failed_ids - submitted_ids)

            missing_source_ids = expected_ids - set(record_map) - processed_ids
            if missing_source_ids:
                raise ValueError(
                    f"Cannot safely process {job_name}; original records are missing for "
                    f"{sorted(missing_source_ids)[:5]}"
                )

            results_count = 0
            logging.info(f"Processing {total_lines} results from batch...")

            for i, result_entry in enumerate(result_entries):
                xid = result_entry["key"]

                if xid in processed_ids and not reprocess:
                    continue

                if i % 100 == 0:
                    logging.info(f"Progress: {i}/{total_lines}...")

                if "error" in result_entry:
                    logging.error(f"Error for record {xid}: {result_entry['error']}")
                    mark_failed(xid, f"batch_error: {result_entry['error']}")
                    continue

                response = result_entry["response"]
                try:
                    candidates = response.get("candidates") or []
                    if not candidates:
                        logging.error(f"Missing candidates for record {xid}")
                        mark_failed(xid, "missing candidates")
                        continue
                    content = candidates[0].get("content") or {}
                    parts = content.get("parts") or []
                    if not parts:
                        logging.error(f"Missing content parts for record {xid}")
                        mark_failed(xid, "missing content parts")
                        continue
                    text_parts = [
                        part.get("text") for part in parts if isinstance(part, dict)
                    ]
                    text = "\n".join([part for part in text_parts if part])
                    if not text:
                        logging.error(f"Missing text parts for record {xid}")
                        mark_failed(xid, "missing text parts")
                        continue
                    start_idx = text.find("{")
                    end_idx = text.rfind("}") + 1
                    if start_idx == -1 or end_idx == -1:
                        logging.warning(f"No JSON found in response for {xid}")
                        mark_failed(xid, "no JSON in response")
                        continue

                    data = json.loads(text[start_idx:end_idx])

                    # Determine if it's the old format (extraction only) or new (combined)
                    if "extraction" in data and "suggested_addresses" in data:
                        # NEW COMBINED FORMAT
                        extraction_data = data["extraction"]
                        addresses = data["suggested_addresses"]
                    else:
                        # OLD EXTRACTION-ONLY FORMAT
                        extraction_data = data
                        addresses = None

                    location_info = LocationInfo(
                        street_name=extraction_data.get("street_name"),
                        neighborhood=extraction_data.get("neighborhood"),
                        landmark=extraction_data.get("landmark"),
                        building_name=extraction_data.get("building_name"),
                        approximate_address=extraction_data.get("approximate_address"),
                        confidence=extraction_data.get("confidence", "low"),
                        historical_context=extraction_data.get("historical_context"),
                    )

                    record = record_map.get(xid)
                    if not record:
                        logging.warning(
                            f"Could not find original record for {xid} in memory map"
                        )
                        continue

                    if location_info.confidence != "low":
                        if not addresses:
                            logging.warning(
                                f"Record {xid} has no suggested_addresses (old batch format). Skipping."
                            )
                            record["llm_error"] = "missing suggested addresses"
                            save_to_file(self.failed_dir, record["xid"], record)
                            continue

                        success = False
                        for addr in addresses or []:
                            geo_result = geocode_with_mapy_cz(addr)
                            if geo_result:
                                geo_result.update(
                                    {
                                        "llm_generated": True,
                                        "llm_model": self.model,
                                        "llm_prompt_hash": self.prompt_hash,
                                        "llm_location_info": asdict(location_info),
                                        "llm_original_address": addr,
                                        "llm_confidence": location_info.confidence,
                                    }
                                )
                                record["geolocation"] = geo_result
                                save_to_file(self.output_dir, record["xid"], record)
                                results_count += 1
                                success = True
                                break

                        if not success:
                            record["llm_error"] = "no geocode match"
                            save_to_file(self.failed_dir, record["xid"], record)
                    else:
                        record["llm_error"] = "low confidence"
                        save_to_file(self.failed_dir, record["xid"], record)

                except Exception as e:
                    logging.error(f"Failed to process result for {xid}: {e}")
                    mark_failed(xid, f"exception: {e}")

            job_data["processed_at"] = datetime.now().isoformat()
            job_data["successful_results"] = results_count
            logging.info(f"Processed {results_count} results for job {job_name}")

        self._save_batches()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Manage Gemini Batch Geolocation jobs")
    parser.add_argument(
        "action",
        choices=["submit", "status", "collect", "process"],
        help="Action to perform",
    )
    parser.add_argument("--limit", type=int, help="Limit number of records for submit")
    parser.add_argument(
        "--redownload",
        action="store_true",
        help="Re-download batch results even if present",
    )
    parser.add_argument(
        "--reprocess",
        action="store_true",
        help="Re-process downloaded batches (for geocoding fixes)",
    )
    parser.add_argument(
        "--job",
        action="append",
        help="Only run against specific batch jobs (full name or suffix)",
    )
    args = parser.parse_args()

    manager = BatchManager()
    if args.action == "submit":
        manager.submit(limit=args.limit)
    elif args.action == "status":
        manager.check_status()
    elif args.action == "collect":
        manager.download_results(redownload=args.redownload, job_filter=args.job)
    elif args.action == "process":
        manager.process_results(reprocess=args.reprocess, job_filter=args.job)
