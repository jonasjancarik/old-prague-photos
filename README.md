# Old Prague Photos Geolocation

This project scrapes, processes, and geolocates historical photos of Prague from the Prague City Archives catalog, then powers a small web viewer for manual review and corrections.

## What is in this repo

- Reproducible data pipeline (scrape -> filter -> geolocate -> export -> manifest)
- Optional LLM-assisted geolocation for unstructured addresses
- Similarity tooling for visually matching scans
- Web viewer (static frontend + optional Cloudflare Pages + D1 backend)

## Requirements

- Python 3.13+
- [uv](https://docs.astral.sh/uv/) package manager
- Mapy.cz API key for geolocation
- (Optional) Gemini API key for LLM batch geolocation
- Node.js/npm for the viewer and Pages function tests

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
# Optional: session cookie TTL in seconds (default: 3600)
# TURNSTILE_SESSION_TTL_SECONDS="3600"
# Optional: allowed Turnstile hostnames (CSV, default: request hostname)
# TURNSTILE_ALLOWED_HOSTNAMES="example.com,www.example.com"
# Optional: disable Turnstile for local dev (localhost only)
TURNSTILE_BYPASS="1"
# Optional: shared rate-limit window in seconds (default: 3600)
# API_RATE_LIMIT_WINDOW_SECONDS="3600"
# Optional: max /api/verify requests per IP/window (default: 15)
# API_RATE_LIMIT_VERIFY_MAX="15"
# Optional: max write requests per IP/window (default: 30)
# API_RATE_LIMIT_WRITE_MAX="30"
# Optional: dedicated rate-limit secret (fallback: TURNSTILE_SESSION_SECRET/TURNSTILE_SECRET_KEY)
# API_RATE_LIMIT_SECRET="your_rate_limit_secret"

# Optional: override archive base URL used for links
ARCHIVE_BASE_URL="https://katalog.ahmp.cz/pragapublica"
# Optional: allow API fallback to archive hosts (default: 0/off)
# ALLOW_ARCHIVE_FALLBACK="0"

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
# Optional: nav progress file for direct scraper debugging; run-directory commands set this automatically
NAV_PROGRESS_FILE="runs/current/collect/nav_partition_progress.json"
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

For the supported non-web pipeline contract, run-directory layout, and script
classifications, see:
- [Pipeline Contract](docs/pipeline-contract.md)
- [Script Inventory](docs/script-inventory.md)

The non-web pipeline runs against an explicit run directory. Each stage reads
and writes within that directory, and `manifest.json` records the resulting
artifacts and run state. Some historical `output/` snapshots are still tracked;
seed them into a run directory with `uv run cli run init <run-dir> --from-output`
when you need to inspect or preserve them.

### 1) Collect

- Fetches record IDs and scrapes per-record metadata.
- Outputs:
  - `<run-dir>/collect/available_record_ids.json` (current ID set)
  - `<run-dir>/collect/raw_records/*.json` (scraped records)
  - `<run-dir>/collect/failed_xids.jsonl` (failures from the latest collect run)
  - `<run-dir>/collect/missing_details_xids.json` (candidate IDs selected by `--rescrape-missing-details`)
  - `<run-dir>/collect/nav_partition_progress.json` (resume cache when using nav partition)

Useful flags:
- `--ids-only` (stop after ID list)
- `--no-fetch-ids` (reuse cached IDs)
- `--rescrape` (overwrite existing raw records)
- `--retry-failed` (retry only IDs from `<run-dir>/collect/failed_xids.jsonl`; implies `--rescrape --no-fetch-ids`)
- `--rescrape-missing-details` (retry only records with incomplete scan metadata; implies `--rescrape --no-fetch-ids`)

### 2) Filter

Splits raw records into categories based on structured house numbers (čp.).

Outputs (JSON):
- `<run-dir>/filter/records_with_cp.json`
- `<run-dir>/filter/records_with_cp_in_record_obsah.json`
- `<run-dir>/filter/records_without_cp.json`

### 3) Geolocate (Mapy.cz)

Geocodes records with structured house numbers via Mapy.cz.

Outputs:
- `<run-dir>/geolocation/ok/*.json` (successful)
- `<run-dir>/geolocation/failed/*.json` (failed)

### 4) Geolocate (LLM batch, optional)

For unstructured addresses, use the Gemini batch API to extract addresses, then geocode.

Commands:
- `uv run cli run geolocate-llm submit <run-dir>`
- `uv run cli run geolocate-llm status <run-dir>`
- `uv run cli run geolocate-llm collect <run-dir>`
- `uv run cli run geolocate-llm process <run-dir>`

Outputs:
- `<run-dir>/geolocation/llm/batch_results/*` (raw batch responses)
- `<run-dir>/geolocation/ok/*.json` (successes, includes LLM metadata)

### 5) Export

Flattens records into the final dataset.

Output:
- `<run-dir>/export/old_prague_photos.csv`

If you updated scan metadata in `<run-dir>/collect/raw_records` but want to avoid re-running geolocation,
backfill scan fields into geolocated records first:

```bash
uv run python scripts/backfill_scan_metadata.py \
  --raw-dir "$RUN_DIR/collect/raw_records" \
  --geo-dir "$RUN_DIR/geolocation/ok"
```

### 6) Build GeoJSON for the viewer

Run `uv run cli derive --run-dir "$RUN_DIR"`.

Outputs:
- `<run-dir>/viewer-data/photos.geojson`

## Running the pipeline

```bash
# Show all commands
uv run cli --help

# Full synchronous pipeline
RUN_DIR=runs/$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE_RECORD_DELAY_S=5 CONCURRENT_REQUESTS=1 uv run cli run pipeline "$RUN_DIR"

# Individual steps
uv run cli run collect "$RUN_DIR"
uv run cli run geolocate-mapy "$RUN_DIR"
uv run cli derive --run-dir "$RUN_DIR"
```

### Verification gates

```bash
npm test
npm run build:viewer
```

`npm test` runs the Python suite through `uv run pytest -q` and the Cloudflare
Pages function tests through Node's built-in test runner.

### Run-directory snapshots

The cleaned-up pipeline boundary is a run directory. A run directory separates
collected snapshots from derived outputs:

```text
runs/<run-id>/
  config.json
  manifest.json
  stage_log.jsonl
  collect/available_record_ids.json
  collect/failed_xids.jsonl
  collect/missing_details_xids.json
  collect/nav_partition_progress.json
  collect/raw_records/
  filter/
  geolocation/ok/
  geolocation/failed/
  geolocation/llm/batches.json
  geolocation/llm/prompts.json
  geolocation/llm/batch_requests/
  geolocation/llm/batch_results/
  export/old_prague_photos.csv
  viewer-data/photos.geojson
```

Create an empty run directory:

```bash
uv run cli run init runs/$(date -u +%Y%m%dT%H%M%SZ)
```

Run the synchronous pipeline in one command:

```bash
RUN_DIR=runs/$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE_RECORD_DELAY_S=5 CONCURRENT_REQUESTS=1 uv run cli run pipeline "$RUN_DIR"
```

`run pipeline` covers archive collection, Mapy.cz geolocation, and deterministic
derived outputs. Each completed run stage appends to `stage_log.jsonl` and
refreshes `manifest.json`.

Collect directly into a run directory. This writes IDs, raw records, failed
record logs, missing-details selections, and nav resume state under `collect/`:

```bash
RUN_DIR=runs/$(date -u +%Y%m%dT%H%M%SZ)
uv run cli run init "$RUN_DIR"
ARCHIVE_RECORD_DELAY_S=5 CONCURRENT_REQUESTS=1 uv run cli run collect "$RUN_DIR"
```

Geolocate that run with Mapy.cz. The command refreshes the run-local filtered
category files from `collect/raw_records/` before writing geolocation results:

```bash
uv run cli run geolocate-mapy "$RUN_DIR"
```

Optionally use Gemini Batch geolocation for unstructured or failed records in
the same run directory:

```bash
uv run cli run geolocate-llm submit "$RUN_DIR" --include-failed-cp
uv run cli run geolocate-llm status "$RUN_DIR"
uv run cli run geolocate-llm collect "$RUN_DIR"
uv run cli run geolocate-llm process "$RUN_DIR"
uv run cli derive --run-dir "$RUN_DIR"
```

Seed a run directory from the current historical `output/` snapshot:

```bash
uv run cli run init runs/current-output --from-output
```

Rebuild the no-network derived outputs from a snapshot:

```bash
uv run cli derive --run-dir runs/current-output
```

`derive` currently covers the deterministic cleanup/export path:
filter raw records, export geolocated records to CSV, build GeoJSON, and write
a run-local manifest. It intentionally does not call the archive, Mapy.cz, or
Gemini; use `uv run cli run collect`, `uv run cli run geolocate-mapy`, and
`uv run cli run geolocate-llm ...` for the networked stages.

### End-to-end playbooks

Full run from zero (from scrape to viewer data, includes geolocation calls):

```bash
RUN_DIR=runs/$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE_RECORD_DELAY_S=5 CONCURRENT_REQUESTS=1 uv run cli run pipeline "$RUN_DIR"
```

Refresh scan/preview metadata without re-running geolocation:

```bash
ARCHIVE_RECORD_DELAY_S=5 CONCURRENT_REQUESTS=1 uv run cli run collect "$RUN_DIR" --rescrape-missing-details
uv run python scripts/backfill_scan_metadata.py --raw-dir "$RUN_DIR/collect/raw_records" --geo-dir "$RUN_DIR/geolocation/ok"
uv run cli derive --run-dir "$RUN_DIR"
```

### Resume tips

- Full ID refresh: `NAV_RESUME=0 uv run cli run collect "$RUN_DIR" --ids-only`
- Reuse cached IDs: `uv run cli run collect "$RUN_DIR" --no-fetch-ids`
- Re-scrape all current IDs: `uv run cli run collect "$RUN_DIR" --no-fetch-ids --rescrape`
- For a resumable full refresh, move `<run-dir>/collect/raw_records` aside and run without `--rescrape`.

## Orphan recovery (gentle, readiness-gated)

When records in `viewer/static/data/orphan_xids.json` need recovery, use
`scripts/orphan_recovery.py` instead of rebuilding orphan lists from ID diff only.

Hard safety rule for archive traffic:
- one archive request every 5 seconds (`--min-interval 5`, `ARCHIVE_RECORD_DELAY_S=5`, `--sleep 5`)

### 1) Create run directory

```bash
RUN="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="runs/recovery/orphans/$RUN"
uv run cli run init "$RUN_DIR" --from-output
```

### 2) Probe orphan xids (resume-safe)

```bash
uv run python scripts/orphan_recovery.py probe \
  --input viewer/static/data/orphan_xids.json \
  --run-dir "$RUN_DIR" \
  --min-interval 5 \
  --timeout 12 \
  --retries 2 \
  --retry-sleep 5
```

Outputs:
- `probe_active.json`
- `probe_not_found.json`
- `probe_transient.json`
- `probe_attempts.jsonl`
- `probe_results.jsonl`

### 3) Seed retry list for targeted rescrape

```bash
uv run python scripts/orphan_recovery.py seed-retry \
  --run-dir "$RUN_DIR" \
  --failed-file "$RUN_DIR/collect/failed_xids.jsonl"
```

### 4) Targeted rescrape (2 passes)

```bash
ARCHIVE_RECORD_DELAY_S=5 CONCURRENT_REQUESTS=1 uv run cli run collect "$RUN_DIR" --retry-failed
ARCHIVE_RECORD_DELAY_S=5 CONCURRENT_REQUESTS=1 uv run cli run collect "$RUN_DIR" --retry-failed
```

### 5) Rebuild viewer data

```bash
uv run python scripts/backfill_scan_metadata.py \
  --raw-dir "$RUN_DIR/collect/raw_records" \
  --geo-dir "$RUN_DIR/geolocation/ok"
uv run cli derive --run-dir "$RUN_DIR"
```

### 6) Build active subset for targeted downloads/similarity

```bash
uv run python scripts/orphan_recovery.py build-subset \
  --run-dir "$RUN_DIR" \
  --photos viewer/static/data/photos.geojson
```

### 7) Gentle preview recovery

```bash
uv run python download_archive_images.py \
  --input "$RUN_DIR/active_subset.geojson" \
  --previews-only \
  --sleep 5 \
  --resolve-timeout 12 \
  --resolve-retries 1 \
  --resolve-retry-sleep 5 \
  --resolve-max-seconds 45
```

Optional gentle tiles:

```bash
uv run python download_archive_images.py \
  --input "$RUN_DIR/active_subset.geojson" \
  --sleep 5 \
  --tile-sleep 0.5
```

### 8) Optional R2 sync

```bash
scripts/r2_sync.sh
# Optional previews sync:
# SRC_DIR=downloads/archive/previews R2_PREFIX=previews scripts/r2_sync.sh
```

### 9) Similarity two-phase

```bash
uv run python build_similarity.py \
  --input "$RUN_DIR/active_subset.geojson" \
  --output "$RUN_DIR/similarity_candidates_subset.json" \
  --clusters-output "$RUN_DIR/series_clusters_subset.json" \
  --r2-tiles-base "$R2_TILES_BASE"

uv run python build_similarity.py --r2-tiles-base "$R2_TILES_BASE"
```

### 10) Finalize orphan list (readiness gate)

```bash
uv run python scripts/orphan_recovery.py finalize \
  --run-dir "$RUN_DIR" \
  --photos viewer/static/data/photos.geojson \
  --raw-dir "$RUN_DIR/collect/raw_records" \
  --downloads-root downloads/archive \
  --output-orphans viewer/static/data/orphan_xids.json
```

`finalize` writes:
- `eligible_unhide.json`
- `excluded_after_recovery.json`
- `summary.json`

`viewer/static/data/orphan_xids.json` is overwritten with `excluded_after_recovery.json`.
Only xids passing readiness are unhidden.

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
- `--previews-only` (download only preview thumbnails; skip Zoomify tiles)
- `--raw-records-dir output/raw_records` (fallback preview source when GeoJSON has empty `scan_previews`)
- `--no-resolve-missing-previews` (disable archive lookup for missing preview metadata)
- `--resolve-timeout 12 --resolve-retries 1 --resolve-retry-sleep 1` (fast, bounded preview URL resolution)
- `--resolve-max-seconds 45` (cap per-xid preview URL resolution time)

Notes for preview-only runs:
- Missing `scan_previews` are now resolved by `xid` from archive permalinks and cached in `downloads/archive/resolved_previews.jsonl`.
- Runs are resumable: existing files in `downloads/archive/previews/<xid>/` are skipped on restart.
- `--stats` now prints `unknown=<n>` for photos that still have no known preview URL metadata.

R2 hosting (optional):
- Upload `downloads/archive/zoomify/` to an R2 bucket prefix (e.g. `tiles/`).
- Set `R2_TILES_BASE=https://<r2-public-domain>/tiles`.
- The app uses R2/own infra first.
- Archive hosts are disabled by default in API routes; enable only if needed with `ALLOW_ARCHIVE_FALLBACK=1`.
- Sync helper: `scripts/r2_sync.sh` (requires `aws` CLI).
- Map popup previews resolve in this order:
  1) R2 `TileGroup0/0-0-0.jpg` via `/api/preview-url`
  2) local cache `downloads/archive/previews/<xid>/scan_0.*` via `/api/preview-local`
  3) feature metadata URLs from `photos.geojson` (non-archive URLs always; archive URLs only when `ALLOW_ARCHIVE_FALLBACK=1`)

Sync previews to R2 (optional; storage/backup, not used by `/api/zoomify`):

```bash
SRC_DIR=downloads/archive/previews R2_PREFIX=previews scripts/r2_sync.sh
```

## Image similarity + version clusters

```bash
python build_similarity.py
```

What it does:
- Computes a composite visual hash per scan (mounted-print crop + dHash + edge-structure hash)
- Produces candidate pairs for visual duplicates
- Builds per-series "version" clusters (scans of the same shot)

Default outputs:
- `viewer/static/data/similarity_candidates.json`
- `viewer/static/data/series_version_clusters.json`
- Cache: `output/similarity/hashes.jsonl`
- Stitched cache: `output/similarity/stitched/<xid>/scan_<n>.jpg`

Notes:
- Source order per scan: local stitched cache -> R2 Zoomify -> feature `scan_zoomify_paths` -> archive permalink (only if `ALLOW_ARCHIVE_FALLBACK=1`) -> preview fallback
- Uses local cache from `downloads/archive/` for previews by default
- Disable cache with `--no-download-cache`
- Override cache root with `--download-root <path>`
- Legacy hash cache lines without `hash_profile` are ignored and recomputed

Useful flags:
- `--pair-distance 18` (conservative duplicate pair queue; default, over 128-bit composite hash)
- `--cluster-distance 32` (within-series version clustering; default, over 128-bit composite hash)
- `--distance 18` (legacy alias; sets both unless explicit split flags are passed)
- `--r2-tiles-base https://<r2-public-domain>/tiles`
- `--allow-archive-fallback` (disabled by default; permits direct archive requests after local/R2/feature sources fail)
- `--stitch-target-long-side 1024`
- `--stitch-max-tiles 16`
- `--hash-size 8` (128-bit composite hash)
- `--limit 200` (smoke test)
- `--sleep 0.2` (throttle)
- `--force` (recompute cache)

LLM-reviewed final duplicate dataset:

```bash
# 1) Write raw hash candidates somewhere stable, so materialization does not
#    overwrite its own source.
PYTHONPATH=. uv run python build_similarity.py \
  --output output/similarity/hash_candidates.json \
  --clusters-output viewer/static/data/series_version_clusters.json

# 2) Review every hash candidate. This is resumable; reruns skip successful
#    pair_id records already present in the JSONL file.
PYTHONPATH=. uv run python scripts/llm_review_similarity.py \
  --input output/similarity/hash_candidates.json \
  --output output/similarity/llm_pair_reviews.jsonl \
  --jobs 10

# 3) Materialize the viewer dataset. By default this keeps only high-confidence
#    same_shot reviews and refuses to publish if any input pair is unreviewed.
PYTHONPATH=. uv run python scripts/llm_review_similarity.py \
  --mode materialize \
  --input output/similarity/hash_candidates.json \
  --output output/similarity/llm_pair_reviews.jsonl \
  --final-output viewer/static/data/similarity_candidates.json
```

The review step sends the stitched scan images as base64 image inputs, applies
the mounted-photo crop by default, and writes one strict JSON verdict per pair:
`same_shot`, `same_scene_variant`, `different`, or `uncertain`. The
materialized pairs keep the original pair fields and add `llm_verdict`,
`llm_confidence`, `llm_reason`, `llm_model`, and `llm_backend`.
Use `--backend codex --model gpt-5.5 --codex-reasoning-effort low` to run
the same adjudication through `codex exec` instead of the direct OpenAI API.
Use `--allow-partial` only for smoke/test materializations.

## Web viewer

The viewer is a static web app with optional Cloudflare Pages + D1 backend for corrections.

Frontend source now lives in `viewer/react/` (React + Vite multi-page app).
Build output stays in `viewer/static/` (served by FastAPI / Wrangler Pages).

### Build frontend

```bash
npm --prefix viewer/react install
npm run build:viewer
```

For iterative UI work, run watch mode in a second terminal:

```bash
npm --prefix viewer/react run dev
```

### Run locally

FastAPI local dev, quickest local loop:

```bash
npm run dev
```

Open `http://127.0.0.1:8000`.

Cloudflare Pages Functions + local D1, closest to production:

```bash
npm run dev:pages
```

Open the URL printed by Wrangler (typically `http://127.0.0.1:8788`).
`dev:pages` applies local D1 migrations, runs the React/static watcher in the background,
and starts Wrangler Pages with local Turnstile bypass.

Full-resolution download (map modal):
- FastAPI runtime exposes server-side stitch via `GET /api/dezoomify?xid=...&scanIndex=...`.
- Pages runtime exposes `fullResDownloadMode=client` and stitches tiles in browser.
- Client mode auto-disables full-res download for archive-host/CORS-blocked sources or scans over `80,000,000` pixels.

See `docs/web-app.md` for full setup, API endpoints, and deployment.

## Utility scripts

- `dezoomify.py`: download and stitch Zoomify tiles into a single image
- `scripts/write_pipeline_manifest.py`: write output hashes/counts and run settings for reproducibility
