"""
Geolocation utilities and Mapy.cz pipeline for Prague historical photos.

This module provides shared utilities for the batch geolocation pipeline
and a Mapy.cz-based geolocation runner:
- Prompt templates for LLM-based location extraction
- LocationInfo dataclass for structured location data
- Mapy.cz geocoding functions
- File I/O helpers
"""

import json
import os
import re
import logging
import requests
import hashlib
import time
from dataclasses import dataclass
from typing import Dict, Optional
from dotenv import load_dotenv

# Prompt versioning storage
PROMPTS_FILE = "output/prompts.json"
OUTPUT_OK_DIR = "output/geolocation/ok"
FAILED_BASE_DIR = "output/geolocation/failed"
RECORDS_WITH_CP = "output/filtered/records_with_cp.json"
RECORDS_WITH_CP_IN_OBSAH = "output/filtered/records_with_cp_in_record_obsah.json"

CP_PATTERN = re.compile(
    r"č\.?\s*p\.?\s*([0-9]+[A-Za-z]?(?:\s*[-–]\s*[0-9]+[A-Za-z]?)?)",
    re.IGNORECASE,
)

load_dotenv()


def get_prompt_hash(prompt: str) -> str:
    """Generate a short hash for a prompt template."""
    return hashlib.sha256(prompt.encode()).hexdigest()[:8]


def save_prompt(prompt_hash: str, prompt: str):
    """Save prompt to the prompts.json file if not already present."""
    prompts = {}
    if os.path.exists(PROMPTS_FILE):
        with open(PROMPTS_FILE, "r", encoding="utf-8") as f:
            prompts = json.load(f)

    if prompt_hash not in prompts:
        prompts[prompt_hash] = prompt
        os.makedirs(os.path.dirname(PROMPTS_FILE), exist_ok=True)
        with open(PROMPTS_FILE, "w", encoding="utf-8") as f:
            json.dump(prompts, f, ensure_ascii=False, indent=2)
        logging.info(f"Saved new prompt with hash {prompt_hash}")


def list_directory(directory):
    """Lists files in a directory and handles FileNotFoundError."""
    try:
        return os.listdir(directory)
    except FileNotFoundError:
        logging.warning(f"Directory not found: {directory}")
        return []


def save_to_file(directory, filename, data):
    """Saves data to a file in the specified directory."""
    if not os.path.exists(directory):
        os.makedirs(directory)
    with open(f"{directory}/{filename}.json", "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False)


def categorize_failed_geolocation(record, query, category):
    """Saves failed geolocation record into a category-specific directory."""
    directory = f"output/geolocation/failed/{category}"
    save_to_file(directory, record["xid"], record)
    logging.error(
        f"Could not geolocate {query} ({record['xid']}) in category {category}"
    )


@dataclass
class LocationInfo:
    """Structured location information extracted from historical photo metadata."""

    street_name: Optional[str] = None
    neighborhood: Optional[str] = None
    landmark: Optional[str] = None
    building_name: Optional[str] = None
    approximate_address: Optional[str] = None
    confidence: str = "low"
    historical_context: Optional[str] = None


# === PROMPT TEMPLATES ===

COMBINED_PROMPT_TEMPLATE = """
Analyzuj tuto historickou fotografii Prahy a navrhni adresy pro geocoding.
Nejdříve se zamysli nad historickým kontextem, změnami názvů ulic a polohou budov.

Popis: "{obsah}"
Místa zmíněná: {misto_entries}
Díla/budovy zmíněná: {dilo_entries}
Datace: {datace}

Vrať JSON objekt s těmito poli:
- "reasoning": tvoje stručná úvaha o lokalitě a moderních názvech (thinking step)
- "extraction": structured extraction (street_name, neighborhood, landmark, building_name, approximate_address, confidence, historical_context)
- "suggested_addresses": array of 3-5 contemporary address strings for Mapy.cz geocoding

Example:
{{
  "reasoning": "Na fotografii je vidět kostel sv. Haštala, který se nachází na Haštalském náměstí. Popis zmiňuje Vězeňskou ulici, která s náměstím sousedí...",
  "extraction": {{
    "street_name": "Vězeňská",
    "neighborhood": "Staré Město",
    ...
  }},
  "suggested_addresses": ["Haštalské náměstí, Praha", "Vězeňská, Praha", "Za Haštalem, Praha"]
}}
"""


def geocode_with_mapy_cz(query: str) -> Optional[Dict]:
    """Geocode a query using Mapy.cz API.

    Tries address search first, then falls back to general search for landmarks/POIs.
    """
    api_key = os.getenv("MAPY_CZ_API_KEY")
    if not api_key:
        logging.warning("MAPY_CZ_API_KEY not set")
        return None

    # First try: strict address search
    params_address = {
        "query": query,
        "limit": 15,
        "locality": "Praha",
        "type": "regional.address",
        "apikey": api_key,
    }

    try:
        for endpoint in ["geocode", "suggest"]:
            response = requests.get(
                f"https://api.mapy.cz/v1/{endpoint}", params=params_address
            )
            response.raise_for_status()
            data = response.json()
            if data.get("items"):
                result = data["items"][0]
                result["endpoint"] = endpoint
                result["match_type"] = "address"
                return result

        # Fallback: general search (includes POIs, landmarks, etc.)
        params_general = {
            "query": query,
            "limit": 15,
            "locality": "Praha",
            "apikey": api_key,
        }

        response = requests.get("https://api.mapy.cz/v1/suggest", params=params_general)
        response.raise_for_status()
        data = response.json()
        if data.get("items"):
            result = data["items"][0]
            result["endpoint"] = "suggest"
            result["match_type"] = data["items"][0].get("type", "unknown")
            return result

        return None
    except Exception as e:
        logging.error(f"Geocoding failed for '{query}': {e}")
        return None


def check_response(string_to_geolocate, geolocation_results, endpoint, record):
    """Checks the geolocation response and saves the coordinates if found."""
    try:
        cp = string_to_geolocate.split("čp. ")[1].split(" ")[0].strip()
        for result in geolocation_results["items"]:
            cp_in_response = re.search(r"(\d+)/", result["name"])
            if cp_in_response and cp_in_response.group(1) == cp:
                record["geolocation"] = result
                record["geolocation"]["endpoint"] = endpoint
                save_to_file("output/geolocation/ok", record["xid"], record)
                return True
    except Exception:
        pass
    return False


def extract_cp_values(text: str):
    if not text:
        return []
    matches = CP_PATTERN.findall(text)
    values = []
    for match in matches:
        for part in re.split(r"[-–]", match):
            value = part.strip()
            if value:
                values.append(value)
    return list(dict.fromkeys(values))


def extract_queries_from_dilo(record):
    queries = []
    for entry in record.get("rejstříkové záznamy", []):
        if entry.get("typ", "").lower() != "dílo":
            continue
        obsah = entry.get("obsah", "")
        if not CP_PATTERN.search(obsah):
            continue
        query = obsah.split(";")[0].strip()
        if query:
            queries.append(query)
    return list(dict.fromkeys(queries))


def extract_queries_from_obsah(record):
    obsah = record.get("obsah", "")
    if not CP_PATTERN.search(obsah):
        return []
    parts = re.split(r"[.!?]", obsah)
    queries = [
        part.strip()
        for part in parts
        if part.strip() and CP_PATTERN.search(part)
    ]
    if not queries and obsah.strip():
        queries = [obsah.strip()]
    return list(dict.fromkeys(queries))


def fetch_mapy_json(endpoint, params, request_delay_s, timeout_s, retries):
    url = f"https://api.mapy.cz/v1/{endpoint}"
    for attempt in range(1, retries + 1):
        if request_delay_s > 0:
            time.sleep(request_delay_s)
        try:
            response = requests.get(url, params=params, timeout=timeout_s)
            if response.status_code in {429, 500, 502, 503, 504}:
                logging.warning(
                    "Mapy.cz %s attempt %s failed with %s",
                    endpoint,
                    attempt,
                    response.status_code,
                )
            response.raise_for_status()
            return response.json()
        except Exception as exc:
            logging.warning("Mapy.cz %s attempt %s failed: %s", endpoint, attempt, exc)
            if attempt == retries:
                return None
            time.sleep(request_delay_s * attempt)
    return None


def search_mapy_items(query, api_key, request_delay_s, timeout_s, retries):
    params_address = {
        "query": query,
        "limit": 15,
        "locality": "Praha",
        "type": "regional.address",
        "apikey": api_key,
    }

    for endpoint in ("geocode", "suggest"):
        data = fetch_mapy_json(endpoint, params_address, request_delay_s, timeout_s, retries)
        if data and data.get("items"):
            return data["items"], endpoint

    params_general = {
        "query": query,
        "limit": 15,
        "locality": "Praha",
        "apikey": api_key,
    }
    data = fetch_mapy_json("suggest", params_general, request_delay_s, timeout_s, retries)
    if data and data.get("items"):
        return data["items"], "suggest"

    return [], None


def find_cp_match(items, cp_values):
    if not cp_values:
        return None
    for item in items:
        name = item.get("name", "")
        match = re.search(r"\b(\d+)\s*/", name)
        if match and match.group(1) in cp_values:
            return item
    for item in items:
        name = item.get("name", "")
        for cp in cp_values:
            if re.search(rf"\b{re.escape(cp)}\b", name):
                return item
    return None


def select_geolocation(items, cp_values, allow_fallback):
    match = find_cp_match(items, cp_values)
    if match:
        return match, "cp"
    if allow_fallback and items:
        return items[0], "fallback"
    return None, None


def geolocate_record(record, queries, api_key, request_delay_s, timeout_s, retries, allow_fallback):
    for query in queries:
        cp_values = extract_cp_values(query)
        items, endpoint = search_mapy_items(
            query, api_key, request_delay_s, timeout_s, retries
        )
        if not items:
            continue
        item, match_type = select_geolocation(items, cp_values, allow_fallback)
        if not item:
            continue
        geolocation = dict(item)
        geolocation["endpoint"] = endpoint
        geolocation["match_type"] = match_type
        geolocation["query"] = query
        record["geolocation"] = geolocation
        save_to_file(OUTPUT_OK_DIR, record["xid"], record)
        return True
    return False


def load_records(path):
    if not os.path.exists(path):
        logging.warning("Missing input file: %s", path)
        return []
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


def get_processed_ids(force):
    if force:
        return set()
    processed = set()
    for filename in list_directory(OUTPUT_OK_DIR):
        if filename.endswith(".json"):
            processed.add(filename.replace(".json", ""))
    if os.path.exists(FAILED_BASE_DIR):
        for root, _, files in os.walk(FAILED_BASE_DIR):
            for filename in files:
                if filename.endswith(".json"):
                    processed.add(filename.replace(".json", ""))
    return processed


def process_records(
    records,
    query_extractor,
    category,
    processed_ids,
    limit,
    api_key,
    request_delay_s,
    timeout_s,
    retries,
    allow_fallback,
):
    total = 0
    success = 0
    failed = 0
    skipped = 0
    remaining = limit

    for record in records:
        if remaining is not None and remaining <= 0:
            break
        xid = record.get("xid")
        if not xid:
            continue
        if xid in processed_ids:
            skipped += 1
            continue
        queries = query_extractor(record)
        if not queries:
            categorize_failed_geolocation(record, "no query", category)
            failed += 1
            total += 1
            if remaining is not None:
                remaining -= 1
            continue
        total += 1
        ok = geolocate_record(
            record,
            queries,
            api_key,
            request_delay_s,
            timeout_s,
            retries,
            allow_fallback,
        )
        if ok:
            success += 1
        else:
            categorize_failed_geolocation(record, queries[0], category)
            failed += 1
        if remaining is not None:
            remaining -= 1
        if total % 100 == 0:
            logging.info(
                "%s progress: %s processed (%s ok, %s failed, %s skipped)",
                category,
                total,
                success,
                failed,
                skipped,
            )

    return {
        "total": total,
        "success": success,
        "failed": failed,
        "skipped": skipped,
        "remaining": remaining,
    }


def main(limit=None, force=False):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(message)s")

    api_key = os.getenv("MAPY_CZ_API_KEY")
    if not api_key:
        logging.error("MAPY_CZ_API_KEY not set")
        return

    request_delay_s = float(os.getenv("MAPY_REQUEST_DELAY_S", "0.2"))
    timeout_s = float(os.getenv("MAPY_REQUEST_TIMEOUT_S", "20"))
    retries = int(os.getenv("MAPY_REQUEST_RETRIES", "3"))
    allow_fallback = os.getenv("MAPY_ALLOW_FALLBACK", "1") != "0"

    processed_ids = get_processed_ids(force)
    records_with_cp = load_records(RECORDS_WITH_CP)
    records_with_cp_in_obsah = load_records(RECORDS_WITH_CP_IN_OBSAH)

    logging.info(
        "Geolocating %s records with čp. and %s records with čp. in popis.",
        len(records_with_cp),
        len(records_with_cp_in_obsah),
    )

    stats_cp = process_records(
        records_with_cp,
        extract_queries_from_dilo,
        "records_with_cp",
        processed_ids,
        limit,
        api_key,
        request_delay_s,
        timeout_s,
        retries,
        allow_fallback,
    )

    remaining = stats_cp["remaining"]
    stats_obsah = process_records(
        records_with_cp_in_obsah,
        extract_queries_from_obsah,
        "records_with_cp_in_record_obsah",
        processed_ids,
        remaining,
        api_key,
        request_delay_s,
        timeout_s,
        retries,
        allow_fallback,
    )

    logging.info(
        "Done. records_with_cp: %s ok, %s failed, %s skipped. records_with_cp_in_record_obsah: %s ok, %s failed, %s skipped.",
        stats_cp["success"],
        stats_cp["failed"],
        stats_cp["skipped"],
        stats_obsah["success"],
        stats_obsah["failed"],
        stats_obsah["skipped"],
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Geolocate Prague records using Mapy.cz"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit geolocation to N records (testing)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-process records even if already geolocated",
    )
    args = parser.parse_args()
    main(limit=args.limit, force=args.force)
