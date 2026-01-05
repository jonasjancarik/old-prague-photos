"""
Geolocation utilities for Prague historical photos.

This module provides shared utilities for the batch geolocation pipeline:
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
from dataclasses import dataclass
from typing import Dict, Optional

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
    """Geocode a query using Mapy.cz API."""
    api_key = os.getenv("MAPY_CZ_API_KEY")
    if not api_key:
        logging.warning("MAPY_CZ_API_KEY not set")
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
