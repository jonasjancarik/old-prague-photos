# Web App (Viewer)

The viewer is a static frontend (Leaflet map + review UIs) with an optional backend for corrections. It can run locally via FastAPI or be deployed to Cloudflare Pages + D1.

## Data inputs

The web app reads static data from `viewer/static/data/`:

- `photos.geojson` (main dataset)
- `similarity_candidates.json` (optional; duplicate review)
- `series_version_clusters.json` (optional; version pills within a group)

Generate inputs:

```bash
python viewer/build_geojson.py
python build_similarity.py
```

## Pages and UI modes

- `/` (index) - map browser + corrections
- `/group-review.html` - per-group review (versions within a series)
- `/dup-review.html` - visual duplicate review (merge decisions)
- `/pomoc.html` - help page

Grouping rules:
- Groups are based on identical `obsah + autor + datace`
- Corrections apply to the group_id
- Version clusters are optional and come from `series_version_clusters.json`

## API endpoints (Cloudflare Pages Functions)

All endpoints live under `/api/*` (see `functions/api/*.js`).

- `GET /api/config` - Turnstile + archive base URL config
- `POST /api/verify` - Turnstile verification, sets session cookie
- `GET /api/review-state` - backend-resolved group roots + latest corrections + done groups
  - `?fresh=1` bypasses edge cache for immediate post-submit refresh
- `GET /api/corrections` - latest corrections (per group)
- `POST /api/corrections` - submit correction / flag
- `GET /api/merges` - latest merge decisions
- `POST /api/merges` - submit merge decision
- `GET /api/admin/review` - maintainer overview (pending corrections, flags, conflicts, recent merges)
- `GET /api/admin/export?format=json|csv&since=...&limit=...` - maintainer export
- `GET /api/preview-url?xid=...` - popup preview URL resolver (R2 -> local cache -> feature metadata)
- `GET /api/preview-local?xid=...&scanIndex=0` - serve local preview file from `downloads/archive/previews`
- `GET /api/zoomify?xid=...&scanIndex=0` - server-side Zoomify metadata
  - Uses R2 if `R2_TILES_BASE` is set and the scan exists there.

Write API hardening:
- `POST /api/verify`, `POST /api/corrections`, `POST /api/merges` require same-origin (`Origin`/`Referer` match).
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
TURNSTILE_BYPASS=1 npx wrangler pages dev viewer/static --local
```

### 4) Deploy

```bash
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
- `/api/preview-url` is used by map hover popups and prefers R2 `0-0-0.jpg` tiles.
- `/api/preview-url` falls back to local preview cache and finally `scan_previews[0]` metadata.
- `/api/zoomify` only uses `R2_TILES_BASE` (tiles path), not preview thumbnails.
- D1 stores corrections + merge decisions (see `migrations/*.sql`).
- `review-state` includes consensus metadata per group:
  - `correction_state`: `none | pending | approved`
  - `anchor_type`: `none | flag | correction`
  - `ok_votes`, `required_ok_votes`, `done`, `needs_confirmation`
- UI copy is Czech-only (see `viewer/static/*.html` + `viewer/static/*.js`).
