# Web App (Viewer)

The viewer is a static frontend (Leaflet map + review UIs) with an optional backend for corrections. It can run locally via FastAPI or be deployed to Cloudflare Pages + D1.

For a plain-English explanation of the 3 separate review/voting systems, see [Community Voting](./community-voting.md).

## Frontend source + build

- React source: `viewer/react/`
- Static output: `viewer/static/`
- Runtime UI logic (legacy modules): `viewer/static/*.js`

Build once before serving/deploying:

```bash
npm --prefix viewer/react install
npm --prefix viewer/react run build
```

For iterative frontend work, run watch mode in another terminal:

```bash
npm --prefix viewer/react run dev
```

## Data inputs

The web app reads static data from `viewer/static/data/`:

- `photos.geojson` (main dataset)
- `similarity_candidates.json` (optional; duplicate review)
- `series_version_clusters.json` (optional; version pills within a group)
- `orphan_xids.json` (xids excluded from map/review UIs)

Generate inputs:

```bash
python viewer/build_geojson.py
python build_similarity.py
```

Generate/update orphan exclusions (readiness-gated, gentle):

```bash
RUN="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="output/recovery/orphans/$RUN"
mkdir -p "$RUN_DIR"

uv run python scripts/orphan_recovery.py probe \
  --input viewer/static/data/orphan_xids.json \
  --run-dir "$RUN_DIR" \
  --min-interval 5 \
  --timeout 12 \
  --retries 2 \
  --retry-sleep 5

uv run python scripts/orphan_recovery.py finalize \
  --run-dir "$RUN_DIR" \
  --photos viewer/static/data/photos.geojson \
  --raw-dir output/raw_records \
  --downloads-root downloads/archive \
  --output-orphans viewer/static/data/orphan_xids.json
```

`orphan_recovery.py` artifacts per run:
- `probe_active.json`
- `probe_not_found.json`
- `probe_transient.json`
- `probe_attempts.jsonl`
- `probe_results.jsonl`
- `eligible_unhide.json`
- `excluded_after_recovery.json`
- `summary.json`

Notes:
- Keep archive load gentle: one request every 5 seconds.
- `viewer/static/data/orphan_xids.json` is driven by readiness outputs, not only by `available_record_ids` diff.
- Legacy quick-diff method can over-hide valid records and is not the default recovery flow.

Similarity generation contract:
- `similarity_candidates.json`
  - Backward compatible keys: `generated_at`, `distance`, `hash_size`, `algo`, `pairs`
  - New key: `pair_distance` (defaults to `8`)
  - Pair schema unchanged: `group_id_a`, `group_id_b`, `distance`, `xid_a`, `xid_b`
- `series_version_clusters.json`
  - Backward compatible keys: `generated_at`, `distance`, `hash_size`, `algo`, `clusters`
  - New key: `cluster_distance` (defaults to `10`)
  - Cluster schema unchanged: `series_id`, `version_id`, `xids`, `representative_xid`, `max_distance`

Hashing source order in `build_similarity.py`:
- local stitched cache (`output/similarity/stitched`)
- R2 Zoomify (`R2_TILES_BASE`)
- feature `scan_zoomify_paths`
- archive permalink fallback
- preview fallback (local preview or metadata URL)

## Pages and UI modes

- `/` (index) - map browser + corrections
- `/group-review.html` - per-group review (versions within a series)
- `/dup-review.html` - visual duplicate review (merge decisions)
- `/pomoc.html` - help page

Group review progress:
- `group-review.html` writes a dedicated backend vote separate from location corrections and merge decisions.
- A series is treated as community-reviewed after `2` independent `ok` votes.
- The reset button on the page only clears the browser-local hide list; it does not delete backend votes.

Index page filtering behavior:
- Year slider + toggles filter the active dataset.
- Metadata search (`Hledat v metadatech fotek…`) further filters the same active dataset.
- Map markers, total count, and photo grid use the combined filter result.
- Address search mode (`Hledat adresu v Praze…`) does not filter photos; it only navigates the map.

Grouping rules:
- Groups are based on identical `obsah + autor + datace`
- Corrections apply to the group_id
- Version clusters are optional and come from `series_version_clusters.json`

## API endpoints (Cloudflare Pages Functions)

All endpoints live under `/api/*` (see `functions/api/*.js`).

- `GET /api/config` - Turnstile + archive base URL config + `fullResDownloadMode` (`client` on Pages Functions)
- `POST /api/verify` - Turnstile verification, sets session cookie
- `GET /api/review-state` - backend-resolved group roots + latest corrections + done groups
  - `?fresh=1` bypasses edge cache for immediate post-submit refresh
- `GET /api/corrections` - latest corrections (per group)
- `POST /api/corrections` - submit correction / flag
- `GET /api/merges` - latest merge decisions
- `POST /api/merges` - submit merge decision (`same`, `different`, `undo` for last-vote revert)
- `GET /api/group-review-votes` - aggregated series-review votes (`ok_votes`, `done`)
- `POST /api/group-review-votes` - submit series-review vote (`ok`, `undo`)
- `GET /api/admin/review` - maintainer overview (pending corrections, flags, conflicts, recent merges)
- `GET /api/admin/export?format=json|csv&since=...&limit=...` - maintainer export
- `GET /api/preview-url?xid=...` - preview URL resolver (R2 tile probe -> feature preview/zoomify fallback)
- `GET /api/preview-local?xid=...&scanIndex=0` - serve local preview file from `downloads/archive/previews`
- `GET /api/zoomify?xid=...&scanIndex=0` - server-side Zoomify metadata
  - Uses R2 if `R2_TILES_BASE` is set and the scan exists there.
- `GET /api/dezoomify?xid=...&scanIndex=0` - FastAPI-only full-resolution JPEG download (tile stitch on server)

Write API hardening:
- `POST /api/verify`, `POST /api/corrections`, `POST /api/merges`, `POST /api/group-review-votes` require same-origin (`Origin`/`Referer` match).
- Per-IP rate limits are enforced in D1.
- Turnstile verification checks `success`, `hostname`, and expected `action`.
- Recommended for production: protect `/admin*` and `/api/admin/*` at Cloudflare WAF/Access.
- Typical failures: `403` origin mismatch/missing, `429` rate limit exceeded (`Retry-After`), `400` invalid Turnstile action/hostname.

## Local development (FastAPI)

FastAPI serves the static app and stores corrections locally in JSONL files:

- `viewer/data/corrections.jsonl`
- `viewer/data/merges.jsonl`
- `viewer/data/feedback.jsonl`

Run:

```bash
npm --prefix viewer/react run build
uv run uvicorn viewer.app:app --reload \
  --reload-dir viewer \
  --reload-dir viewer/static \
  --reload-include "*.html" \
  --reload-include "*.css" \
  --reload-include "*.js" \
  --reload-include "*.geojson"
```

Open `http://127.0.0.1:8000`.

Turnstile bypass is local-only: `TURNSTILE_BYPASS=1` is honored only on `localhost`/`127.0.0.1`/`::1`.

## Cloudflare Pages + D1

### 1) Create database

```bash
npx wrangler login
npx wrangler d1 create old-prague-photos
```

Update `wrangler.toml` with the `database_id`.

### 2) Run migrations

```bash
npx wrangler d1 migrations apply CORRECTIONS_DB --local
npx wrangler d1 migrations apply CORRECTIONS_DB
```

### 3) Local Pages dev

```bash
npm --prefix viewer/react run build
TURNSTILE_BYPASS=1 npx wrangler pages dev viewer/static --local
```

### 4) Deploy

```bash
npm --prefix viewer/react run build
npx wrangler pages deploy viewer/static --project-name <project-name>
```

## Environment variables

For Pages (set in the Cloudflare dashboard or `wrangler.toml`):

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `TURNSTILE_SESSION_SECRET` (optional; defaults to secret key)
- `TURNSTILE_SESSION_TTL_SECONDS` (optional; defaults to `3600`)
- `TURNSTILE_ALLOWED_HOSTNAMES` (optional CSV; defaults to request hostname)
- `TURNSTILE_BYPASS=1` (dev only; localhost-only)
- `API_RATE_LIMIT_WINDOW_SECONDS` (optional; defaults to `3600`)
- `API_RATE_LIMIT_VERIFY_MAX` (optional; defaults to `15`)
- `API_RATE_LIMIT_WRITE_MAX` (optional; defaults to `30`)
- `API_RATE_LIMIT_SECRET` (optional; falls back to Turnstile/session secret)
- `ARCHIVE_BASE_URL` (optional)
- `R2_TILES_BASE` (optional; points to public R2 prefix with tiles)
- `ALLOW_ARCHIVE_FALLBACK` (optional; default `0`. When `1`, `/api/preview-url` and `/api/zoomify` may use archive-host URLs as a last resort)
- `FULLRES_MAX_PIXELS` (FastAPI-only; optional; default `80000000` for `/api/dezoomify`)

## Sync to R2

Use the helper script to sync downloaded tiles to R2 (requires `aws` CLI):

```bash
R2_BUCKET=old-prague \\
R2_ACCOUNT_ID=xxxx \\
R2_ACCESS_KEY_ID=... \\
R2_SECRET_ACCESS_KEY=... \\
scripts/r2_sync.sh
```

Optional: sync preview thumbnails as well:

```bash
SRC_DIR=downloads/archive/previews R2_PREFIX=previews scripts/r2_sync.sh
```

## Notes

- `/api/zoomify` avoids browser CORS issues with `ImageProperties.xml`.
- Full-resolution download mode is advertised via `/api/config`:
  - `server` (FastAPI) -> frontend uses `/api/dezoomify`.
  - `client` (Pages Functions) -> frontend stitches tiles in browser.
- `/api/preview-url` is used by map hover popups and prefers R2 `0-0-0.jpg` tiles.
- `/api/preview-url` falls back to `scan_previews` / `scan_zoomify_paths` only for non-archive URLs by default; archive-host fallbacks require `ALLOW_ARCHIVE_FALLBACK=1`.
- `/api/zoomify` resolves in this order: `R2_TILES_BASE` -> feature `scan_zoomify_paths` -> archive permalink (only when `ALLOW_ARCHIVE_FALLBACK=1`).
- In client mode, full-res download is disabled when Zoomify source is archive-host/CORS-blocked or image area exceeds `80,000,000` pixels.
- Frontend filters out xids listed in `viewer/static/data/orphan_xids.json` on `/`, `/pomoc.html`, `/dup-review.html`, and `/group-review.html`.
- D1 stores corrections + merge decisions (see `migrations/*.sql`).
- `review-state` includes consensus metadata per group:
  - `correction_state`: `none | pending | approved`
  - `anchor_type`: `none | flag | correction`
  - `ok_votes`, `required_ok_votes`, `done`, `needs_confirmation`
- UI copy is Czech-only (React templates in `viewer/react/src/templates/*.html` + runtime logic in `viewer/static/*.js`).
