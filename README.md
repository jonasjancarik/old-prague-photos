# Old Prague Photos Geolocation

This project scrapes, processes, and geolocates historical photos of Prague from the Prague City Archives catalog, then powers a small web viewer for manual review and corrections.

## What is in this repo

- Data pipeline (scrape -> filter -> geolocate -> export)
- Optional LLM-assisted geolocation for unstructured addresses
- Similarity tooling for visually matching scans
- Web viewer (static frontend + optional Cloudflare Pages + D1 backend)

## Requirements

- Python 3.13+
- [uv](https://docs.astral.sh/uv/) package manager
- Mapy.cz API key for geolocation
- (Optional) Gemini API key for LLM batch geolocation

## Setup

```bash
git clone <repo>
cd old-prague-photos
uv sync
```

Create `.env` in the repo root:

```env
MAPY_CZ_API_KEY="your_mapy_cz_api_key_here"
# Optional: throttle Mapy.cz requests
# MAPY_REQUEST_DELAY_S="0.2"
# MAPY_REQUEST_RETRIES="3"
# MAPY_REQUEST_TIMEOUT_S="20"
# MAPY_ALLOW_FALLBACK="1"

# Optional: Gemini Batch LLM for unstructured addresses
GEMINI_API_KEY="your_gemini_api_key_here"
# Optional: override the default model (defaults to gemini/gemini-3-flash-preview)
# LLM_MODEL="gemini/gemini-3-flash-preview"

# Viewer app (Cloudflare Turnstile)
TURNSTILE_SITE_KEY="your_turnstile_site_key_here"
TURNSTILE_SECRET_KEY="your_turnstile_secret_key_here"
# Optional: override session signing key
# TURNSTILE_SESSION_SECRET="your_session_secret"
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

## Pipeline overview (detailed)

The pipeline is a sequence of scripts. Each step reads from `output/` and writes new artifacts there. Note: `output/` is tracked in git, so do not store large image downloads there.

### 1) Collect (`collect.py`)

- Fetches record IDs and scrapes per-record metadata.
- Outputs:
  - `output/available_record_ids.json` (current ID set)
  - `output/raw_records/*.json` (scraped records)
  - `output/nav_partition_progress.json` (resume cache when using nav partition)

Useful flags:
- `--ids-only` (stop after ID list)
- `--no-fetch-ids` (reuse cached IDs)
- `--rescrape` (overwrite existing raw records)

### 2) Filter (`filter.py`)

Splits raw records into categories based on structured house numbers (čp.).

Outputs (JSON):
- `output/filtered/records_with_cp.json`
- `output/filtered/records_with_cp_in_record_obsah.json`
- `output/filtered/records_without_cp.json`

### 3) Geolocate (Mapy.cz)

Geocodes records with structured house numbers via Mapy.cz.

Outputs:
- `output/geolocation/ok/*.json` (successful)
- `output/geolocation/failed/*.json` (failed)

### 4) Geolocate (LLM batch, optional)

For unstructured addresses, use the Gemini batch API to extract addresses, then geocode.

Commands:
- `uv run cli geolocate llm submit`
- `uv run cli geolocate llm status`
- `uv run cli geolocate llm collect`
- `uv run cli geolocate llm process`

Outputs:
- `output/batch_results/*` (raw batch responses)
- `output/geolocation/ok/*.json` (successes, includes LLM metadata)

### 5) Export (`export.py`)

Flattens records into the final dataset.

Output:
- `output/old_prague_photos.csv`

### 6) Build GeoJSON for the viewer

```bash
python viewer/build_geojson.py
```

Outputs:
- `viewer/static/data/photos.geojson`

## Running the pipeline

```bash
# Show all commands
uv run cli --help

# Full pipeline
uv run cli pipeline

# Individual steps
uv run cli collect
uv run cli filter
uv run cli geolocate mapy
uv run cli export
```

### Resume tips

- Full ID refresh: `NAV_RESUME=0 uv run cli collect --ids-only`
- Reuse cached IDs: `uv run cli collect --no-fetch-ids`
- Re-scrape all current IDs: `uv run cli collect --no-fetch-ids --rescrape`
- For a resumable full refresh, move `output/raw_records` aside and run without `--rescrape`.

## Archive download cache (gentle, resumable)

The archive is slow/fragile. Use this script to download previews + full Zoomify tiles with delay and resume support:

```bash
python download_archive_images.py
```

Defaults:
- Output: `downloads/archive/` (gitignored)
- Delay: 10s between photos
- Resume: skips existing files

Useful flags:
- `--sleep 10` (delay between photos)
- `--tile-sleep 0.2` (delay between tiles)
- `--limit 50` (smoke test)
- `--force` (redownload)
- `--output-dir <path>` (custom cache root)

R2 hosting (optional):
- Upload `downloads/archive/zoomify/` to an R2 bucket prefix (e.g. `zoomify/`).
- Set `R2_ZOOMIFY_BASE=https://<r2-public-domain>/zoomify`.
- The app will use R2 if `ImageProperties.xml` exists there; otherwise it falls back to the archive.
 - Sync helper: `scripts/r2_sync.sh` (requires `aws` CLI).

## Image similarity + version clusters

```bash
python build_similarity.py
```

What it does:
- Computes a perceptual hash (dHash) per scan
- Produces candidate pairs for visual duplicates
- Builds per-series "version" clusters (scans of the same shot)

Outputs:
- `viewer/static/data/similarity_candidates.json`
- `viewer/static/data/series_version_clusters.json`
- Cache: `output/similarity/hashes.jsonl`

Notes:
- Uses local cache from `downloads/archive/` by default
- Falls back to network if cache missing
- Disable cache with `--no-download-cache`
- Override cache root with `--download-root <path>`

Useful flags:
- `--distance 8` (lower = stricter)
- `--hash-size 8` (64-bit hash)
- `--limit 200` (smoke test)
- `--sleep 0.2` (throttle)
- `--force` (recompute cache)

## Web viewer

The viewer is a static web app with optional Cloudflare Pages + D1 backend for corrections.

See `docs/web-app.md` for full setup, API endpoints, and deployment.

## Utility scripts

- `dezoomify.py`: download and stitch Zoomify tiles into a single image
- `check.py`: debugging helper for geolocation results
