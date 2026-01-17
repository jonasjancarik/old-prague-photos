import json
import os
import logging
import time
from dataclasses import asdict
from typing import Dict, Optional
from datetime import datetime
from google import genai
from google.genai import types
from dotenv import load_dotenv

# Re-use utilities from geolocate.py
from geolocate import (
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
FAILED_DIR = "output/geolocation/failed/records_without_cp_llm"

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


class BatchManager:
    def __init__(self):
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            logging.error("GEMINI_API_KEY not found in environment variables.")
            exit(1)
        self.client = genai.Client(api_key=api_key)
        self.model = os.getenv("LLM_MODEL", "gemini/gemini-3-flash-preview").replace(
            "gemini/", "models/"
        )
        self.prompt_hash = get_prompt_hash(COMBINED_PROMPT_TEMPLATE)
        save_prompt(self.prompt_hash, COMBINED_PROMPT_TEMPLATE)
        self.batches = self._load_batches()
        logging.info(f"BatchManager initialized with model: {self.model}")

    def _load_batches(self) -> Dict:
        if os.path.exists(BATCHES_FILE):
            with open(BATCHES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    def _save_batches(self):
        os.makedirs(os.path.dirname(BATCHES_FILE), exist_ok=True)
        with open(BATCHES_FILE, "w", encoding="utf-8") as f:
            json.dump(self.batches, f, ensure_ascii=False, indent=2)

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
        records_to_process = []
        record_ids_to_process = set()

        # Get already processed IDs
        geolocated_files = list_directory(OUTPUT_DIR)
        geolocation_failed_files = []
        for root, dirs, files in os.walk("output/geolocation/failed"):
            for filename in files:
                geolocation_failed_files.append(filename.replace(".json", ""))

        # Check which geolocated records are LLM-generated (for --redo-llm)
        llm_geolocated_ids = set()
        direct_geolocated_ids = set()
        for f in geolocated_files:
            xid = f.replace(".json", "")
            try:
                with open(os.path.join(OUTPUT_DIR, f), "r", encoding="utf-8") as file:
                    record = json.load(file)
                    if record.get("geolocation", {}).get("llm_generated"):
                        llm_geolocated_ids.add(xid)
                    else:
                        direct_geolocated_ids.add(xid)
            except Exception:
                direct_geolocated_ids.add(xid)  # Assume direct if can't read

        # Determine which IDs to skip
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

        # Load filtered records (records_without_cp and records_with_cp_in_record_obsah)
        filtered_files = list_directory(INPUT_RECORDS_DIR)
        for f in filtered_files:
            # Include both unstructured records AND those with čp. only in description
            if f.endswith(".json") and (
                "records_without_cp" in f or "records_with_cp_in_record_obsah" in f
            ):
                with open(
                    os.path.join(INPUT_RECORDS_DIR, f), "r", encoding="utf-8"
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
                "output/geolocation/failed/records_with_cp",
                "output/geolocation/failed/records_with_cp_in_record_obsah",
            ]
            failed_files = []
            for failed_dir in failed_dirs:
                if os.path.exists(failed_dir):
                    failed_files.extend(
                        [
                            os.path.join(failed_dir, f)
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
                    with open(filepath, "r", encoding="utf-8") as file:
                        record = json.load(file)
                    xid = record["xid"]
                    if xid in record_ids_to_process:
                        continue
                    records_to_process.append(record)
                    record_ids_to_process.add(xid)

        if retry_missing_content and os.path.exists(FAILED_DIR):
            retry_errors = {
                "missing candidates",
                "missing content parts",
                "missing text parts",
                "no JSON in response",
            }
            retry_files = [
                f for f in list_directory(FAILED_DIR) if f.endswith(".json")
            ]
            retry_count = 0
            for filename in retry_files:
                with open(os.path.join(FAILED_DIR, filename), "r", encoding="utf-8") as file:
                    record = json.load(file)
                if record.get("llm_error") not in retry_errors:
                    continue
                xid = record["xid"]
                if xid in record_ids_to_process:
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
        batch_filename = f"output/batch_request_{int(time.time())}.jsonl"
        with open(batch_filename, "w", encoding="utf-8") as f:
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
                f.write(json.dumps(request, ensure_ascii=False) + "\n")

        # Upload file
        logging.info(f"Uploading {batch_filename}...")
        uploaded_file = self.client.files.upload(
            file=batch_filename,
            config=types.UploadFileConfig(
                display_name=os.path.basename(batch_filename),
                mime_type="application/jsonl",
            ),
        )

        # Create batch job
        logging.info(f"Creating batch job with model {self.model}...")
        job = self.client.batches.create(
            model=self.model,
            src=uploaded_file.name,
            config=types.CreateBatchJobConfig(
                display_name=f"Geolocation_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            ),
        )

        # Store metadata
        self.batches[job.name] = {
            "name": job.name,
            "display_name": job.display_name,
            "state": job.state.name,
            "created_at": datetime.now().isoformat(),
            "input_file": batch_filename,
            "record_count": len(records_to_process),
        }
        self._save_batches()
        logging.info(f"Batch job created: {job.name}")

    def check_status(self):
        """Check status of active jobs and update metadata."""
        active_jobs = [
            j
            for j, data in self.batches.items()
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

    def collect_results(self, recollect: bool = False):
        """Check status first, then download results and geocode.

        Args:
            recollect: If True, re-process already collected batches (for geocoding fixes)
        """
        self.check_status()

        if recollect:
            # Re-process all succeeded jobs, not just uncollected ones
            completed_jobs = [
                j
                for j, data in self.batches.items()
                if data["state"] == "JOB_STATE_SUCCEEDED"
            ]
            logging.info(
                f"--recollect: Will re-process {len(completed_jobs)} batch jobs"
            )
        else:
            completed_jobs = [
                j
                for j, data in self.batches.items()
                if data["state"] == "JOB_STATE_SUCCEEDED" and "collected_at" not in data
            ]

        if not completed_jobs:
            logging.info("No completed jobs to collect.")
            return

        for job_name in completed_jobs:
            job_data = self.batches[job_name]
            output_file_name = job_data.get("output_file")
            if not output_file_name:
                logging.warning(f"No output file for succeeded job {job_name}")
                continue

            logging.info(f"Downloading results for {job_name}...")
            content = self.client.files.download(file=output_file_name)
            os.makedirs(BATCH_RESULTS_DIR, exist_ok=True)
            results_path = os.path.join(
                BATCH_RESULTS_DIR, f"{job_name.replace('/', '_')}.jsonl"
            )
            with open(results_path, "wb") as results_file:
                results_file.write(content)
            logging.info("Saved batch results to %s", results_path)

            # Load all filtered records into a map for fast lookup
            record_map = {}
            filtered_files = list_directory(INPUT_RECORDS_DIR)
            for f in filtered_files:
                # Include records_without_cp AND records_with_cp_in_record_obsah
                if "records_without_cp" in f or "records_with_cp_in_record_obsah" in f:
                    with open(
                        os.path.join(INPUT_RECORDS_DIR, f), "r", encoding="utf-8"
                    ) as file:
                        for r in json.load(file):
                            record_map[r["xid"]] = r

            # Also load from failed directories (for --include-failed-cp batch results)
            for root, dirs, files in os.walk("output/geolocation/failed"):
                for filename in files:
                    if filename.endswith(".json"):
                        with open(
                            os.path.join(root, filename), "r", encoding="utf-8"
                        ) as file:
                            r = json.load(file)
                            record_map[r["xid"]] = r

            # Get already geolocated IDs to support resuming
            geolocated_ids = {
                f.replace(".json", "") for f in list_directory(OUTPUT_DIR)
            }
            failed_ids = set()
            for root, dirs, files in os.walk("output/geolocation/failed"):
                for filename in files:
                    failed_ids.add(filename.replace(".json", ""))

            processed_ids = geolocated_ids.union(failed_ids)

            def mark_failed(xid, reason):
                record = record_map.get(xid)
                if not record:
                    logging.warning(
                        "Could not find original record for %s in memory map", xid
                    )
                    return
                record["llm_error"] = reason
                save_to_file(FAILED_DIR, record["xid"], record)

            results_count = 0
            lines = content.decode("utf-8").splitlines()
            total_lines = len(lines)
            logging.info(f"Processing {total_lines} results from batch...")

            for i, line in enumerate(lines):
                if not line.strip():
                    continue
                result_entry = json.loads(line)
                xid = result_entry["key"]

                if xid in processed_ids and not recollect:
                    # Skip already processed (unless recollecting)
                    continue

                if i % 100 == 0:
                    logging.info(f"Progress: {i}/{total_lines}...")

                # Check for errors in the individual request
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
                        # If no addresses in the batch response (old format), skip
                        if not addresses:
                            logging.warning(
                                f"Record {xid} has no suggested_addresses (old batch format). Skipping."
                            )
                            record["llm_error"] = "missing suggested addresses"
                            save_to_file(FAILED_DIR, record["xid"], record)
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
                                save_to_file(OUTPUT_DIR, record["xid"], record)
                                results_count += 1
                                success = True
                                break

                        if not success:
                            record["llm_error"] = "no geocode match"
                            save_to_file(FAILED_DIR, record["xid"], record)
                    else:
                        record["llm_error"] = "low confidence"
                        save_to_file(FAILED_DIR, record["xid"], record)

                except Exception as e:
                    logging.error(f"Failed to process result for {xid}: {e}")
                    mark_failed(xid, f"exception: {e}")

            job_data["collected_at"] = datetime.now().isoformat()
            job_data["successful_results"] = results_count
            logging.info(f"Collected {results_count} results for job {job_name}")

        self._save_batches()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Manage Gemini Batch Geolocation jobs")
    parser.add_argument(
        "action", choices=["submit", "status", "collect"], help="Action to perform"
    )
    parser.add_argument("--limit", type=int, help="Limit number of records for submit")
    args = parser.parse_args()

    manager = BatchManager()
    if args.action == "submit":
        manager.submit(limit=args.limit)
    elif args.action == "status":
        manager.check_status()
    elif args.action == "collect":
        manager.collect_results()
