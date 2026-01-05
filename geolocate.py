import json
import os
import re
import logging
import requests
import hashlib
from dotenv import load_dotenv
import time
import argparse
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional
import litellm

# Prompt versioning storage
PROMPTS_FILE = "output/prompts.json"


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
    street_name: Optional[str] = None
    neighborhood: Optional[str] = None
    landmark: Optional[str] = None
    building_name: Optional[str] = None
    approximate_address: Optional[str] = None
    confidence: str = "low"
    historical_context: Optional[str] = None


class LLMGeolocator:
    # Prompt templates (defined as class vars for hashing)
    EXTRACTION_PROMPT_TEMPLATE = """
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

    SYNTHESIS_PROMPT_TEMPLATE = """
Na základě extrahovaných informací o historické fotografii Prahy vytvoř možné adresy pro geocoding:

Extrahované informace:
- Ulice: {street_name}
- Čtvrť: {neighborhood}
- Památka/landmark: {landmark}
- Budova: {building_name}
- Přibližná adresa: {approximate_address}
- Rok: {year}

Vygeneruj 3-5 možných adres, které by mohly být úspěšně geocodovány v současné Praze:
- Zohledni historické změny názvů ulic
- Použij současné názvy pražských městských částí
- Zahrň alternativní formáty (s/bez čísla, s/bez městské části)

Vrať pouze JSON array řetězců:
["adresa1", "adresa2", "adresa3", ...]
"""

    def __init__(self):
        # Model configurable via env, defaults to Gemini Flash (cheap and fast)
        self.model = os.getenv("LLM_MODEL", "gemini/gemini-3-flash-preview")

        # Compute and store prompt hashes for tracking
        self.extraction_prompt_hash = get_prompt_hash(self.EXTRACTION_PROMPT_TEMPLATE)
        self.synthesis_prompt_hash = get_prompt_hash(self.SYNTHESIS_PROMPT_TEMPLATE)

        # Save prompts to file on init
        save_prompt(self.extraction_prompt_hash, self.EXTRACTION_PROMPT_TEMPLATE)
        save_prompt(self.synthesis_prompt_hash, self.SYNTHESIS_PROMPT_TEMPLATE)

        logging.info(f"LLMGeolocator initialized with model: {self.model}")

    def extract_location_info(self, record: Dict) -> LocationInfo:
        """Extract structured location information from record"""
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

        prompt = self.EXTRACTION_PROMPT_TEMPLATE.format(
            obsah=obsah,
            misto_entries=misto_entries,
            dilo_entries=dilo_entries,
            datace=datace,
        )

        try:
            response = litellm.completion(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=1.0,
                max_tokens=500,
            )

            response_text = response.choices[0].message.content
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
            return LocationInfo(confidence="low")
        except Exception as e:
            logging.error(
                f"Error extracting location info for {record.get('xid')}: {e}"
            )
            return LocationInfo(confidence="low")

    def synthesize_addresses(self, location_info: LocationInfo, year: str) -> List[str]:
        """Generate possible addresses for geocoding"""
        if location_info.confidence == "low":
            return []

        prompt = self.SYNTHESIS_PROMPT_TEMPLATE.format(
            street_name=location_info.street_name,
            neighborhood=location_info.neighborhood,
            landmark=location_info.landmark,
            building_name=location_info.building_name,
            approximate_address=location_info.approximate_address,
            year=year,
        )

        try:
            response = litellm.completion(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                temperature=1.0,
                max_tokens=300,
            )

            response_text = response.choices[0].message.content
            start_idx = response_text.find("[")
            end_idx = response_text.rfind("]") + 1

            if start_idx != -1 and end_idx != -1:
                json_str = response_text[start_idx:end_idx]
                return [addr for addr in json.loads(json_str) if addr]
            return []
        except Exception as e:
            logging.error(f"Error synthesizing addresses: {e}")
            return []


def geocode_with_mapy_cz(query: str) -> Optional[Dict]:
    """Geocode a query using Mapy.cz API"""
    api_key = os.getenv("MAPY_CZ_API_KEY")
    if not api_key:
        return None

    params = {
        "query": query,
        "limit": 15,
        "locality": "Praha",
        "type": "regional.address",
        "apikey": api_key,
    }

    try:
        for endpoint in ["geocode", "suggest"]:
            response = requests.get(f"https://api.mapy.cz/v1/{endpoint}", params=params)
            response.raise_for_status()
            data = response.json()
            if data.get("items"):
                result = data["items"][0]
                result["endpoint"] = endpoint
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


def try_llm_addresses(record: Dict, geolocator: LLMGeolocator) -> Optional[Dict]:
    """Try geocoding using LLM-generated addresses"""
    try:
        location_info = geolocator.extract_location_info(record)
        if location_info.confidence == "low":
            return None

        addresses = geolocator.synthesize_addresses(
            location_info, record.get("datace", "")
        )
        for address in addresses:
            result = geocode_with_mapy_cz(address)
            if result:
                result.update(
                    {
                        "llm_generated": True,
                        "llm_model": geolocator.model,
                        "llm_extraction_prompt_hash": geolocator.extraction_prompt_hash,
                        "llm_synthesis_prompt_hash": geolocator.synthesis_prompt_hash,
                        "llm_location_info": asdict(location_info),
                        "llm_original_address": address,
                        "llm_confidence": location_info.confidence,
                    }
                )
                return result
        return None
    except Exception as e:
        logging.error(f"LLM processing error for {record['xid']}: {e}")
        return None


def main():
    load_dotenv()
    parser = argparse.ArgumentParser(description="Geolocate Prague historical photos")
    parser.add_argument("--llm-limit", type=int, help="Limit LLM processing")
    parser.add_argument("--force", action="store_true", help="Re-process all")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
    )

    api_key = os.getenv("MAPY_CZ_API_KEY")
    if not api_key:
        logging.error("MAPY_CZ_API_KEY missing")
        return

    # Load records
    records = {}
    for f in list_directory("output/filtered"):
        with open(f"output/filtered/{f}", "r", encoding="utf-8") as file:
            records[f.replace(".json", "")] = json.load(file)

    geolocated_ids = {
        f.replace(".json", "") for f in list_directory("output/geolocation/ok")
    }
    failed_ids = {
        f.split("/")[-1].replace(".json", "")
        for root, ds, fs in os.walk("output/geolocation/failed")
        for f in fs
    }

    skipped_ids = set() if args.force else geolocated_ids.union(failed_ids)

    # Process structured
    structured = [
        r for r in records.get("records_with_cp", []) if r["xid"] not in skipped_ids
    ]
    logging.info(f"Geolocating {len(structured)} structured records")

    for record in structured:
        zaznam = next(
            (
                z
                for z in record.get("rejstříkové záznamy", [])
                if "čp." in z["obsah"].lower()
            ),
            None,
        )
        if not zaznam:
            continue

        query = zaznam["obsah"].split(";")[0].strip()
        params = {
            "query": query,
            "limit": 15,
            "locality": "Praha",
            "type": "regional.address",
            "apikey": api_key,
        }

        try:
            for endpoint in ["geocode", "suggest"]:
                resp = requests.get(f"https://api.mapy.cz/v1/{endpoint}", params=params)
                if resp.ok and check_response(query, resp.json(), endpoint, record):
                    break
            else:
                categorize_failed_geolocation(record, query, "records_with_cp")
        except Exception as e:
            logging.error(f"Error: {e}")

    # Process LLM
    llm_api_available = any(
        os.getenv(k) for k in ["GEMINI_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"]
    )
    if llm_api_available and "records_without_cp" in records:
        unstructured = [
            r for r in records["records_without_cp"] if r["xid"] not in skipped_ids
        ]
        if args.llm_limit:
            unstructured = unstructured[: args.llm_limit]

        if unstructured:
            geolocator = LLMGeolocator()
            for record in unstructured:
                result = try_llm_addresses(record, geolocator)
                if result:
                    record["geolocation"] = result
                    save_to_file("output/geolocation/ok", record["xid"], record)
                else:
                    categorize_failed_geolocation(
                        record, "LLM failed", "records_without_cp_llm"
                    )
                time.sleep(0.4)


if __name__ == "__main__":
    main()
