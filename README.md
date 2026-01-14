# Old Prague Photos Geolocation 📸

This project scrapes, processes, and geolocates historical photos of Prague from the [Prague City Archives](http://katalog.ahmp.cz/pragapublica) public catalog. The final output is a structured CSV file containing photo metadata and geographical coordinates, suitable for mapping applications.

## ⚙️ Project Workflow

The data processing is handled by a series of scripts that form a sequential pipeline. Each step uses the output of the previous one.

1.  **`collect.py`**: Fetches record IDs into `output/available_record_ids.json`, then scrapes metadata for those IDs into `output/raw_records/`. Use `--ids-only` to stop after IDs, `--no-fetch-ids` to reuse the existing ID list, and `--rescrape` to overwrite existing raw records.

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

# Optional: use nav-tree partitioning to bypass the 10k cap (default true)
USE_NAV_PARTITION="1"
# Optional: nav label to expand (default "Sbírka fotografií")
NAV_PARTITION_LABEL="Sbírka fotografií"
# Optional: throttle requests to avoid 500s
ARCHIVE_REQUEST_DELAY_S="1.5"
# Optional: throttle record scraping requests
ARCHIVE_RECORD_DELAY_S="0.0"
# Optional: retries per archive request
ARCHIVE_FETCH_RETRIES="4"
# Optional: hard cap for ViewControl page rows
ARCHIVE_MAX_ROWS="10000"
# Optional: only fetch IDs (skip record scraping)
FETCH_IDS_ONLY="1"
# Optional: nav progress file for resume
NAV_PROGRESS_FILE="output/nav_partition_progress.json"
# Optional: resume nav progress file (default true)
NAV_RESUME="1"
# Optional: limit nav child nodes per run
NAV_MAX_NODES="5"
# Optional: restrict nav labels (comma-separated)
NAV_ONLY_LABELS="I,II,XIV"
# Optional: allow partial nav results without error
NAV_ALLOW_PARTIAL="1"
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
uv run cli collect                   # Fetch IDs + scrape missing raw records
uv run cli collect --ids-only         # Only refresh available_record_ids.json
uv run cli collect --no-fetch-ids     # Scrape using existing available_record_ids.json
uv run cli collect --rescrape         # Re-scrape all IDs (overwrite raw_records)
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

## Collect Outputs and Resume Behavior

- `output/available_record_ids.json`: current ID set (what collect considers the source of truth).
- `output/raw_records/*.json`: per-record metadata; may include older IDs not in the current ID set.
- `output/nav_partition_progress.json`: per-label ID cache for nav partitioning; used to resume ID fetches.

Resume tips:
- Full ID refresh: `NAV_RESUME=0 uv run cli collect --ids-only`
- Use cached IDs: `uv run cli collect --no-fetch-ids`
- Re-scrape all current IDs: `uv run cli collect --no-fetch-ids --rescrape`
- For resumable full refresh, move `output/raw_records` out of the way and run without `--rescrape`.

## 🗺️ Viewer App

The viewer is a static frontend (Leaflet map + feedback modal). It can run locally via FastAPI or as a static site on Cloudflare Pages with a D1 database for live corrections. Photos are grouped by identical `obsah + autor + datace` so versions appear together; corrections apply to the whole group. There is also a similarity review UI at `/dup-review.html` for manually merging groups that look like the same shot (even if scans differ). By default it compares groups with identical coordinates; if `viewer/static/data/similarity_candidates.json` exists, those pairs are included too.

Future idea: keep corrections in a live store (KV/D1) for instant map updates, and optionally run a daily GitHub Action that snapshots corrections into a PR (CSV + GeoJSON) for audit/history.

### Architecture (Cloudflare)

- Static site: `viewer/static/` (HTML/CSS/JS), deployed on **Cloudflare Pages**.
- “Backend”: **Pages Functions** in `functions/api/*.js` (runs on **Cloudflare Workers runtime**) under `/api/*`.
- DB: Cloudflare **D1** bound as `env.CORRECTIONS_DB` (see `wrangler.toml`).

### Build GeoJSON

Generate the map data from the CSV export:

```bash
python viewer/build_geojson.py
```

This writes `viewer/static/data/photos.geojson` for static hosting.

### Build similarity candidates

Generate candidate pairs for similar shots using perceptual hashing:

```bash
python build_similarity.py
```

This writes `viewer/static/data/similarity_candidates.json` for the review UI and caches hashes in `output/similarity/`.

How it works (short):

- Resolves the Zoomify image for each `xid` and fetches **only the smallest tile** (level 0, 1 tile) to avoid HQ downloads.
- Computes a dHash (perceptual hash) on that small preview.
- Builds candidate pairs with a BK-tree + Hamming distance threshold.
- The review UI reads these pairs and mixes them with same-coordinate candidates.

Useful flags:

- `--distance 8` (lower = stricter, fewer candidates)
- `--hash-size 8` (grid size; 8 => 64-bit hash)
- `--limit 200` (smoke test)
- `--sleep 0.2` (throttle requests)
- `--force` (recompute hash cache)
- `--archive-base-url <url>` (override archive host)

Output format (`viewer/static/data/similarity_candidates.json`):

- `pairs[]` items: `group_id_a`, `group_id_b`, `xid_a`, `xid_b`, `distance`

### Run locally (FastAPI)

```bash
uv run uvicorn viewer.app:app --reload \
  --reload-dir viewer \
  --reload-dir viewer/static \
  --reload-include "*.html" \
  --reload-include "*.css" \
  --reload-include "*.js" \
  --reload-include "*.geojson"
```

Open `http://127.0.0.1:8000`. Corrections are stored at `viewer/data/corrections.jsonl`.

### Cloudflare Pages + D1 (recommended)

TL;DR (common ops): see `ops.sh`.

#### `ops.sh` cheat-sheet

```bash
./ops.sh build-data
./ops.sh build-similarity
./ops.sh dev-fastapi
./ops.sh dev-pages
./ops.sh migrate-local
./ops.sh migrate-remote
PROJECT_NAME=<project-name> ./ops.sh deploy
```

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

#### Deploy (manual)

```bash
npx wrangler pages deploy viewer/static --project-name <project-name>
```

#### Notes

- `/api/zoomify` resolves Zoomify metadata server-side (avoids browser CORS issues with `ImageProperties.xml`).
- UI is Czech-only for now (copy lives in `viewer/static/*.html` + `viewer/static/*.js`).

## 🛠️ Utility Scripts

The repository also includes a couple of utility scripts for specific tasks:

-   **`dezoomify.py`**: A standalone tool to download and stitch together high-resolution tiled images from the archive's Zoomify viewer. You need to provide the page URL directly in the script.
-   **`check.py`**: A script for validating and debugging the geolocation results by comparing the extracted neighborhood name with the results from the geolocation API.
