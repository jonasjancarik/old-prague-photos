import json
import os
import re
import logging
import requests
from dotenv import load_dotenv
import time
import argparse
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional
import litellm

# Parse command line arguments first
parser = argparse.ArgumentParser(
    description="Geolocate Prague historical photos using Mapy.cz API and optional LLM processing"
)
parser.add_argument(
    "--llm-limit",
    type=int,
    help="Limit the number of records to process with LLM (for testing purposes)",
)
args = parser.parse_args()
LLM_LIMIT = args.llm_limit

# Setup logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

if LLM_LIMIT:
    logging.info(f"LLM processing will be limited to {LLM_LIMIT} records for testing")

load_dotenv()

MAPY_CZ_API_KEY = os.getenv("MAPY_CZ_API_KEY")
if not MAPY_CZ_API_KEY:
    logging.error("MAPY_CZ_API_KEY not found in environment variables.")
    exit(1)

# Check for any LLM API key (LiteLLM auto-detects from standard env vars)
# Supported: OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, etc.
LLM_API_KEY_AVAILABLE = any(
    os.getenv(key)
    for key in [
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "ANTHROPIC_API_KEY",
    ]
)
if LLM_API_KEY_AVAILABLE:
    logging.info("LLM API key found - LLM processing will be available")
else:
    logging.warning("No LLM API key found - LLM processing will be skipped")


def list_directory(directory):
    """Lists files in a directory and handles FileNotFoundError."""
    try:
        return os.listdir(directory)
    except FileNotFoundError:
        logging.warning(f"Directory not found: {directory}")
        return []


def categorize_failed_geolocation(record, query, category):
    """Saves failed geolocation record into a category-specific directory."""
    directory = f"output/geolocation/failed/{category}"
    if not os.path.exists(directory):
        os.makedirs(directory)
    save_to_file(directory, record["xid"], record)
    logging.error(
        f"Could not geolocate {query} ({record['xid']}) in category {category}"
    )


@dataclass
class LocationInfo:
    street_name: Optional[str] = None
    neighborhood: Optional[str] = None
    landmark: Optional[str] = None
    building_name: Optional[str] = None
    approximate_address: Optional[str] = None
    confidence: str = "low"
    historical_context: Optional[str] = None


class LLMGeolocator:
    def __init__(self):
        # Model configurable via env, defaults to Gemini Flash (cheap and fast)
        # Examples: "gpt-4o", "gemini/gemini-2.0-flash", "claude-3-haiku-20240307"
        self.model = os.getenv("LLM_MODEL", "gemini/gemini-2.0-flash")
        logging.info(f"LLMGeolocator initialized with model: {self.model}")

    def extract_location_info(self, record: Dict) -> LocationInfo:
        """Extract structured location information from record"""

        # Prepare input data
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

        # Create extraction prompt
        prompt = f"""
Analyzuj tuto historickou fotografii Prahy a extrahuj informace o lokalizaci:

Popis: "{obsah}"
Místa zmíněná: {misto_entries}
Díla/budovy zmíněná: {dilo_entries}
Datace: {datace}

Extrahuj a vrať ve formátu JSON:
{{
  "street_name": "název ulice pokud je zmíněn",
  "neighborhood": "městská část/čtvrť (např. Vinohrady, Smíchov, Staré Město)",
  "landmark": "významná budova nebo památka",
  "building_name": "název konkrétní budovy",
  "approximate_address": "nejlepší odhad adresy pro geocoding",
  "confidence": "high|medium|low",
  "historical_context": "historický kontext a změny názvů"
}}

Pravidla:
- Pokud nejsou informace k dispozici, použij null
- Confidence "high" = jasná adresa, "medium" = identifikovatelná oblast, "low" = vágní
- U approximate_address preferuj formát "ulice číslo, Praha-čtvrť"
- Zohledni historické názvy a jejich moderní ekvivalenty
"""

        try:
            response = litellm.completion(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=500,
            )

            # Parse JSON response
            response_text = response.choices[0].message.content

            # Extract JSON from response
            start_idx = response_text.find("{")
            end_idx = response_text.rfind("}") + 1

            if start_idx != -1 and end_idx != -1:
                json_str = response_text[start_idx:end_idx]
                data = json.loads(json_str)

                return LocationInfo(
                    street_name=data.get("street_name"),
                    neighborhood=data.get("neighborhood"),
                    landmark=data.get("landmark"),
                    building_name=data.get("building_name"),
                    approximate_address=data.get("approximate_address"),
                    confidence=data.get("confidence", "low"),
                    historical_context=data.get("historical_context"),
                )
            else:
                logging.warning(
                    f"Could not parse JSON from LLM response for {record.get('xid', 'unknown')}"
                )
                return LocationInfo(confidence="low")

        except Exception as e:
            logging.error(
                f"Error extracting location info for {record.get('xid', 'unknown')}: {e}"
            )
            return LocationInfo(confidence="low")

    def synthesize_addresses(self, location_info: LocationInfo, year: str) -> List[str]:
        """Generate possible addresses for geocoding"""

        if location_info.confidence == "low":
            return []

        # Create synthesis prompt
        prompt = f"""
Na základě extrahovaných informací o historické fotografii Prahy vytvoř možné adresy pro geocoding:

Extrahované informace:
- Ulice: {location_info.street_name}
- Čtvrť: {location_info.neighborhood}
- Památka/landmark: {location_info.landmark}
- Budova: {location_info.building_name}
- Přibližná adresa: {location_info.approximate_address}
- Rok: {year}

Vygeneruj 3-5 možných adres, které by mohly být úspěšně geocodovány v současné Praze:
- Zohledni historické změny názvů ulic
- Použij současné názvy pražských městských částí
- Zahrň alternativní formáty (s/bez čísla, s/bez městské části)

Vrať pouze JSON array řetězců:
["adresa1", "adresa2", "adresa3", ...]
"""

        try:
            response = litellm.completion(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=300,
            )

            response_text = response.choices[0].message.content

            # Extract JSON array from response
            start_idx = response_text.find("[")
            end_idx = response_text.rfind("]") + 1

            if start_idx != -1 and end_idx != -1:
                json_str = response_text[start_idx:end_idx]
                addresses = json.loads(json_str)
                return [addr for addr in addresses if addr]  # Filter out empty strings
            else:
                logging.warning("Could not parse address array from LLM response")
                return []

        except Exception as e:
            logging.error(f"Error synthesizing addresses: {e}")
            return []


def geocode_with_mapy_cz(query: str) -> Optional[Dict]:
    """Geocode a query using Mapy.cz API"""
    params = {
        "query": query,
        "limit": 15,
        "locality": "Praha",
        "type": "regional.address",
        "apikey": MAPY_CZ_API_KEY,
    }

    try:
        # Try geocode endpoint first
        endpoint = "geocode"
        response = requests.get(f"https://api.mapy.cz/v1/{endpoint}", params=params)
        response.raise_for_status()
        geolocation_results = response.json()

        if geolocation_results.get("items"):
            result = geolocation_results["items"][0]
            result["endpoint"] = endpoint
            return result

        # Retry with suggestions API
        endpoint = "suggest"
        response = requests.get(f"https://api.mapy.cz/v1/{endpoint}", params=params)
        response.raise_for_status()
        geolocation_results = response.json()

        if geolocation_results.get("items"):
            result = geolocation_results["items"][0]
            result["endpoint"] = endpoint
            return result

        return None

    except requests.RequestException as e:
        logging.error(f"Geocoding request failed for '{query}': {e}")
        return None


def try_llm_addresses(record: Dict, geolocator: LLMGeolocator) -> Optional[Dict]:
    """Try geocoding using LLM-generated addresses"""

    try:
        # Extract location information
        location_info = geolocator.extract_location_info(record)

        # Skip low confidence results
        if location_info.confidence == "low":
            logging.info(f"Skipping {record['xid']} due to low LLM confidence")
            return None

        # Generate possible addresses
        addresses = geolocator.synthesize_addresses(
            location_info, record.get("datace", "")
        )

        if not addresses:
            logging.info(f"No addresses generated for {record['xid']}")
            return None

        # Try each address
        for i, address in enumerate(addresses):
            logging.info(
                f"Trying LLM address {i + 1}/{len(addresses)} for {record['xid']}: {address}"
            )

            result = geocode_with_mapy_cz(address)

            if result:
                # Add LLM metadata to the result
                result["llm_generated"] = True
                result["llm_location_info"] = asdict(location_info)
                result["llm_original_address"] = address
                result["llm_confidence"] = location_info.confidence

                logging.info(
                    f"Successfully geocoded {record['xid']} using LLM address: {address}"
                )
                return result

        logging.info(f"No LLM addresses worked for {record['xid']}")
        return None

    except Exception as e:
        logging.error(f"Error in LLM processing for {record['xid']}: {e}")
        return None


# Load records from files
records = {}
filtered_files = list_directory("output/filtered")
for filtered_file in filtered_files:
    with open(f"output/filtered/{filtered_file}", "r", encoding="utf-8") as file:
        records[filtered_file.replace(".json", "")] = json.load(file)

# records_with_cp - those have a house number and can be geolocated using the mapy.cz API
# records_with_cp_in_record_obsah - these have the house number in the "obsah" key, unstructured - LLM should be used to extract the house number
# records_without_cp - no house number, LLM should be used to extract a street or landmark name
# records_without_dilo - subset of the above, no "dílo" in the "rejstříkové záznamy" key, might be tricky to geolocate

# Get list of all files in output/geolocation
geolocated_files = list_directory("output/geolocation/ok")
# Get list of all files in output/geolocation/failed and its subdirectories (not including directory names)
geolocation_failed_files = [
    f"{root}/{filename}"
    for root, dirs, files in os.walk("output/geolocation/failed")
    for filename in files
]

# Sets of geolocated and failed ids
geolocated_ids = {filename.replace(".json", "") for filename in geolocated_files}
geolocation_failed_ids = {
    filename.split("/")[-1].replace(".json", "")
    for filename in geolocation_failed_files
}


def check_response(string_to_geolocate, geolocation_results, endpoint, record):
    """Checks the geolocation response and saves the coordinates if found."""
    cp = string_to_geolocate.split("čp. ")[1].split(" ")[0].strip()
    for result in geolocation_results["items"]:
        cp_in_response = re.search(r"(\d+)/", result["name"])
        if cp_in_response and cp_in_response.group(1) == cp:
            record["geolocation"] = result
            record["geolocation"]["endpoint"] = endpoint
            save_to_file("output/geolocation/ok", record["xid"], record)
            return True
    return False


def save_to_file(directory, filename, data):
    """Saves data to a file in the specified directory."""
    if not os.path.exists(directory):
        os.makedirs(directory)
    with open(f"{directory}/{filename}.json", "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False)


logging.info(f"Loaded {len(records['records_with_cp'])} records with čp.")

# drop records that have already been geolocated, even unsuccessfully
geolocated_and_failed_ids = geolocated_ids.union(geolocation_failed_ids)

logging.info(
    f"Will skip {len(geolocated_and_failed_ids)} already geolocated records ({len(geolocated_ids)} successfully and {len(geolocation_failed_ids)} where geolocation failed)."
)

# check how many records in records["records_with_cp"] are duplicates based on record["xid"]
xids = [record["xid"] for record in records["records_with_cp"]]
unique_xids = set(xids)
if len(xids) != len(unique_xids):
    logging.warning(
        f"Found {len(xids) - len(unique_xids)} duplicates in records_with_cp."
    )

records_to_geolocate = [
    record
    for record in records["records_with_cp"]
    if record["xid"] not in geolocated_and_failed_ids
]

# Initialize counters
total_records = len(records_to_geolocate)
processed_records = 0
start_time = time.time()

logging.info(f"Geolocating {total_records} records")

# Geolocate records
for record in records_to_geolocate:
    # Find the rejistriovy zaznam with the house number
    zaznam = next(
        (
            z
            for z in record.get("rejstříkové záznamy", [])
            if "čp." in z["obsah"].lower()
        ),
        None,
    )
    if not zaznam:
        logging.warning(f"No 'čp.' found in records for xid: {record['xid']}")
        continue

    string_to_geolocate = zaznam["obsah"].split(";")[0].strip()
    logging.info(f"Geolocating: {string_to_geolocate}")

    # Geolocate using mapy.cz API
    params = {
        "query": string_to_geolocate,
        "limit": 15,
        "locality": "Praha",
        "type": "regional.address",
        "apikey": MAPY_CZ_API_KEY,
    }
    try:
        endpoint = "geocode"
        response = requests.get(f"https://api.mapy.cz/v1/{endpoint}", params=params)
        response.raise_for_status()
        geolocation_results = response.json()

        if not check_response(
            string_to_geolocate, geolocation_results, endpoint, record
        ):
            # Retry with the suggestions API
            logging.info("Retrying with the suggestions API")
            endpoint = "suggest"
            response = requests.get(f"https://api.mapy.cz/v1/{endpoint}", params=params)
            response.raise_for_status()
            geolocation_results = response.json()

            if check_response(
                string_to_geolocate, geolocation_results, endpoint, record
            ):
                logging.info("Geolocated with the suggestions API")
            else:
                category = "records_with_cp"
                categorize_failed_geolocation(record, params["query"], category)

    except requests.RequestException as e:
        logging.error(f"Request failed: {e}")

    processed_records += 1
    elapsed_time = time.time() - start_time
    items_per_minute = processed_records / elapsed_time * 60
    eta = (total_records - processed_records) / items_per_minute

    print(
        f"{processed_records}/{total_records} ({items_per_minute:.2f} items/min) ETA: {eta:.2f} min"
    )

logging.info("Finished processing records with structured addresses (čp.)")

# ===== LLM-BASED PROCESSING FOR RECORDS WITHOUT STRUCTURED ADDRESSES =====

if LLM_API_KEY_AVAILABLE and "records_without_cp" in records:
    logging.info(
        "Starting LLM-based processing for records without structured addresses..."
    )

    # Filter out records that have already been processed
    records_without_cp_to_process = [
        record
        for record in records["records_without_cp"]
        if record["xid"] not in geolocated_and_failed_ids
    ]

    # Apply LLM limit if specified
    if LLM_LIMIT and LLM_LIMIT < len(records_without_cp_to_process):
        records_without_cp_to_process = records_without_cp_to_process[:LLM_LIMIT]
        logging.info(
            f"Limiting LLM processing to first {LLM_LIMIT} records for testing"
        )

    logging.info(
        f"Found {len(records_without_cp_to_process)} records without structured addresses to process"
    )

    if records_without_cp_to_process:
        geolocator = LLMGeolocator()

        # Initialize counters for LLM processing
        llm_total_records = len(records_without_cp_to_process)
        llm_processed_records = 0
        llm_successful_records = 0
        llm_start_time = time.time()

        logging.info(f"Processing {llm_total_records} records using LLM...")

        for record in records_without_cp_to_process:
            logging.info(
                f"Processing record {llm_processed_records + 1}/{llm_total_records}: {record['xid']}"
            )

            # Try LLM-generated addresses
            result = try_llm_addresses(record, geolocator)

            if result:
                # Save successful LLM geolocation
                record["geolocation"] = result
                save_to_file("output/geolocation/ok", record["xid"], record)
                llm_successful_records += 1
                logging.info(
                    f"Successfully geolocated {record['xid']} using LLM (confidence: {result.get('llm_confidence', 'unknown')})"
                )
            else:
                # Save failed LLM geolocation
                categorize_failed_geolocation(
                    record, "LLM processing failed", "records_without_cp_llm"
                )

            llm_processed_records += 1

            # Progress reporting
            if (
                llm_processed_records % 10 == 0
                or llm_processed_records == llm_total_records
            ):
                elapsed_time = time.time() - llm_start_time
                items_per_minute = llm_processed_records / elapsed_time * 60
                eta = (
                    (llm_total_records - llm_processed_records) / items_per_minute
                    if items_per_minute > 0
                    else 0
                )
                success_rate = (llm_successful_records / llm_processed_records) * 100

                print(
                    f"LLM: {llm_processed_records}/{llm_total_records} ({items_per_minute:.2f} items/min) "
                    f"Success: {success_rate:.1f}% ETA: {eta:.2f} min"
                )

            # Rate limiting for LLM API
            time.sleep(0.4)

        logging.info(
            f"LLM processing complete. Successfully geolocated {llm_successful_records}/{llm_total_records} "
            f"records ({(llm_successful_records / llm_total_records) * 100:.1f}% success rate)"
        )

else:
    if not LLM_API_KEY_AVAILABLE:
        logging.info("Skipping LLM processing - no LLM API key provided")
    else:
        logging.info("No records without structured addresses found to process")

logging.info("All geolocation processing complete.")
