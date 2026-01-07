# Old Prague Photos Geolocation 📸

This project scrapes, processes, and geolocates historical photos of Prague from the [Prague City Archives](http://katalog.ahmp.cz/pragapublica) public catalog. The final output is a structured CSV file containing photo metadata and geographical coordinates, suitable for mapping applications.

## ⚙️ Project Workflow

The data processing is handled by a series of scripts that form a sequential pipeline. Each step uses the output of the previous one.

1.  **`collect.py`**: Scrapes the archive website to get a list of all photo record IDs. It then scrapes the detailed metadata for each record and saves them as individual JSON files in `output/raw_records/`.

2.  **`filter.py`**: Reads the raw records and filters them into categories. It primarily separates records that contain a structured house number (`čp.`) from those that don't. The categorized lists are saved as JSON files in `output/filtered/`.

3.  **`geolocate.py`**: Processes the records that have a house number. It uses the [Mapy.cz API](https://api.mapy.cz/) to find the geographical coordinates for each address. Successfully geolocated records are saved in `output/geolocation/ok/`, while failures are moved to `output/geolocation/failed/`.

4.  **`export.py`**: Reads all successfully geolocated JSON files. It parses date information, flattens the data structure, and exports the final, clean dataset to `output/old_prague_photos.csv`.

---

## 🚀 Getting Started

Follow these steps to set up and run the project locally.

### 1. Prerequisites

-   Python 3.13 or newer
-   [uv](https://docs.astral.sh/uv/) - fast Python package manager
-   A Mapy.cz API key for the geolocation step. You can get one from the [Mapy.cz API developer page](https://api.mapy.cz/).

### 2. Setup

First, clone the repository to your local machine:
```bash
git clone <your-repository-url>
cd <your-repository-directory>
```

Install dependencies using uv (this also creates a virtual environment automatically):
```bash
uv sync
```

Create a `.env` file in the project's root directory to store your API keys:

```env
MAPY_CZ_API_KEY="your_mapy_cz_api_key_here"

# Choose ONE of the following LLM providers (LiteLLM auto-detects):
GEMINI_API_KEY="your_gemini_api_key_here"      # Recommended (cheap + fast)
# OPENAI_API_KEY="your_openai_api_key_here"    # Alternative
# ANTHROPIC_API_KEY="your_anthropic_key_here"  # Alternative

# Optional: Override the default model (defaults to gemini/gemini-2.0-flash)
# LLM_MODEL="gpt-4o"                           # For OpenAI
# LLM_MODEL="claude-3-haiku-20240307"          # For Anthropic

# Viewer app (Cloudflare Turnstile)
TURNSTILE_SITE_KEY="your_turnstile_site_key_here"
TURNSTILE_SECRET_KEY="your_turnstile_secret_key_here"

# Optional: disable Turnstile for local dev
TURNSTILE_BYPASS="1"

# Optional: override archive base URL used for links
ARCHIVE_BASE_URL="https://katalog.ahmp.cz/pragapublica"
```

**Note:** An LLM API key is required for the LLM-based address extraction feature.

### 3. Running the Pipeline

Use the CLI to run individual steps or the full pipeline:

```bash
# Show all available commands
uv run cli --help

# Run the full pipeline
uv run cli pipeline

# Or run individual steps:
uv run cli collect      # Scrape records from archive
uv run cli filter       # Filter and categorize records
uv run cli geolocate    # Geolocate using Mapy.cz + LLM
uv run cli export       # Export to CSV

# Test LLM with limited records:
uv run cli geolocate --llm-limit 5

# Force re-run (re-process already geolocated records):
uv run cli geolocate --force
```

### LLM-Based Address Extraction

The `geolocate.py` script now includes integrated LLM processing for photos that don't contain structured addresses (čp.). When you run `python geolocate.py`, it will automatically:

1. **First**: Process records with structured house numbers using the Mapy.cz API
2. **Then**: Process records without structured addresses using OpenAI's GPT-4o to:
   - Analyze Czech photo descriptions and metadata
   - Extract streets, neighborhoods, landmarks, and building names
   - Generate multiple candidate addresses for geocoding
   - Assess confidence levels for each extraction
   - Consider historical context and name changes

The LLM processing is automatic if you have an OpenAI API key set. If not, it will skip the LLM processing and only handle structured addresses.

**LLM Processing Features:**
- Rate-limited to respect OpenAI API limits (2.5 requests/second)
- Confidence-based filtering (only tries medium+ confidence extractions)
- Comprehensive logging and progress reporting
- Failed attempts are categorized separately for analysis

**Testing LLM Functionality:**
```bash
# Test with a limited number of records first
uv run cli geolocate --llm-limit 10

# Process normally (all records)
uv run cli geolocate

# Force re-run with a different model
LLM_MODEL=gpt-4o uv run cli geolocate --force

# Show help and options
uv run cli geolocate --help
```
After running all the steps, the final dataset will be available at `output/old_prague_photos.csv`.

---

## 🗺️ Viewer App

The viewer is a static frontend (Leaflet map + feedback modal). It can run locally via FastAPI or as a static site on Cloudflare Pages with a D1 database for live corrections.

Future idea: keep corrections in a live store (KV/D1) for instant map updates, and optionally run a daily GitHub Action that snapshots corrections into a PR (CSV + GeoJSON) for audit/history.

### Build GeoJSON

Generate the map data from the CSV export:

```bash
python viewer/build_geojson.py
```

This writes `viewer/static/data/photos.geojson` for static hosting.

### Run locally (FastAPI)

```bash
uv run uvicorn viewer.app:app --reload
```

Open `http://127.0.0.1:8000`. Corrections are stored at `viewer/data/corrections.jsonl`.

### Cloudflare Pages + D1 (recommended)

1. Login + create D1:
   ```bash
   npx wrangler login
   npx wrangler d1 create old-prague-photos
   ```
2. Update `wrangler.toml` with the D1 `database_id`.
3. Apply migrations:
   ```bash
   npx wrangler d1 migrations apply CORRECTIONS_DB --local
   ```
4. Local dev with Pages:
   ```bash
   TURNSTILE_BYPASS=1 npx wrangler pages dev viewer/static --local
   ```

For Turnstile in Cloudflare, set `TURNSTILE_SITE_KEY` as a Pages env var and `TURNSTILE_SECRET_KEY` as a Pages secret.

## 🛠️ Utility Scripts

The repository also includes a couple of utility scripts for specific tasks:

-   **`dezoomify.py`**: A standalone tool to download and stitch together high-resolution tiled images from the archive's Zoomify viewer. You need to provide the page URL directly in the script.
-   **`check.py`**: A script for validating and debugging the geolocation results by comparing the extracted neighborhood name with the results from the geolocation API.
