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
    ):
        """Prepare and submit batch job.

        Args:
            limit: Max records to process (for testing)
            redo_llm: If True, also re-process records that were previously LLM-geolocated
            include_failed_cp: If True, include records that failed direct geocoding
        """
        records_to_process = []

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

        # Load filtered records
        filtered_files = list_directory(INPUT_RECORDS_DIR)
        for f in filtered_files:
            if f.endswith(".json") and "records_without_cp" in f:
                with open(
                    os.path.join(INPUT_RECORDS_DIR, f), "r", encoding="utf-8"
                ) as file:
                    all_records = json.load(file)
                    for record in all_records:
                        if record["xid"] not in processed_ids:
                            records_to_process.append(record)

        # Optionally include failed structured records for LLM processing
        if include_failed_cp:
            failed_cp_dir = "output/geolocation/failed/records_with_cp"
            if os.path.exists(failed_cp_dir):
                failed_cp_files = [
                    f for f in list_directory(failed_cp_dir) if f.endswith(".json")
                ]
                logging.info(
                    f"--include-failed-cp: Adding {len(failed_cp_files)} failed structured records"
                )
                for f in failed_cp_files:
                    with open(
                        os.path.join(failed_cp_dir, f), "r", encoding="utf-8"
                    ) as file:
                        record = json.load(file)
                        records_to_process.append(record)

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

    def collect_results(self):
        """Check status first, then download results and geocode."""
        self.check_status()

        completed_jobs = [
            j
            for j, data in self.batches.items()
            if data["state"] == "JOB_STATE_SUCCEEDED" and "collected_at" not in data
        ]

        if not completed_jobs:
            logging.info("No new completed jobs to collect.")
            return

        for job_name in completed_jobs:
            job_data = self.batches[job_name]
            output_file_name = job_data.get("output_file")
            if not output_file_name:
                logging.warning(f"No output file for succeeded job {job_name}")
                continue

            logging.info(f"Downloading results for {job_name}...")
            content = self.client.files.download(file=output_file_name)

            # Load all filtered records into a map for fast lookup
            record_map = {}
            filtered_files = list_directory(INPUT_RECORDS_DIR)
            for f in filtered_files:
                if "records_without_cp" in f:
                    with open(
                        os.path.join(INPUT_RECORDS_DIR, f), "r", encoding="utf-8"
                    ) as file:
                        for r in json.load(file):
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

            results_count = 0
            lines = content.decode("utf-8").splitlines()
            total_lines = len(lines)
            logging.info(f"Processing {total_lines} results from batch...")

            for i, line in enumerate(lines):
                if not line.strip():
                    continue
                result_entry = json.loads(line)
                xid = result_entry["key"]

                if xid in processed_ids:
                    # Skip already processed
                    continue

                if i % 100 == 0:
                    logging.info(f"Progress: {i}/{total_lines}...")

                # Check for errors in the individual request
                if "error" in result_entry:
                    logging.error(f"Error for record {xid}: {result_entry['error']}")
                    continue

                response = result_entry["response"]
                try:
                    text = response["candidates"][0]["content"]["parts"][0]["text"]
                    start_idx = text.find("{")
                    end_idx = text.rfind("}") + 1
                    if start_idx == -1 or end_idx == -1:
                        logging.warning(f"No JSON found in response for {xid}")
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
                            save_to_file(FAILED_DIR, record["xid"], record)
                    else:
                        save_to_file(FAILED_DIR, record["xid"], record)

                except Exception as e:
                    logging.error(f"Failed to process result for {xid}: {e}")

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
