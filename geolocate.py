import json
import os
import re
import logging
import requests
from dotenv import load_dotenv
import time

# Setup logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

load_dotenv()

MAPY_CZ_API_KEY = os.getenv("MAPY_CZ_API_KEY")
if not MAPY_CZ_API_KEY:
    logging.error("MAPY_CZ_API_KEY not found in environment variables.")
    exit(1)


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
