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
- `GET /api/corrections` - latest corrections (per group)
- `POST /api/corrections` - submit correction / flag
- `GET /api/merges` - latest merge decisions
- `POST /api/merges` - submit merge decision
- `GET /api/zoomify?xid=...&scanIndex=0` - server-side Zoomify metadata

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

Turnstile is enforced unless `TURNSTILE_BYPASS=1` is set.

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
- `TURNSTILE_BYPASS=1` (dev only)
- `ARCHIVE_BASE_URL` (optional)

## Notes

- `/api/zoomify` avoids browser CORS issues with `ImageProperties.xml`.
- D1 stores corrections + merge decisions (see `migrations/*.sql`).
- UI copy is Czech-only (see `viewer/static/*.html` + `viewer/static/*.js`).
