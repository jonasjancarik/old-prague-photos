# Web App (Viewer)

The production architecture is a static Vite frontend on Cloudflare Pages with
Pages Functions and D1 for community state. FastAPI remains a compatibility
runtime for the server-side full-resolution image stitcher and the quick local
preview loop; Pages + D1 is the canonical contribution runtime.

Community help docs:
- maintainer reference: [Community Help Workflows](./community-voting.md)
- Czech user-facing guide: [Komunitní pomoc](./komunitni-pomoc.md)

## Frontend source + build

- Page templates and Vite entries: `viewer/react/` (the directory name is kept
  for path compatibility; the React runtime has been removed)
- Static output: `viewer/static/`
- Runtime UI modules: `viewer/static/*.js`

Each page has one HTML template and one vanilla Vite entry. The entry mounts the
template before loading the page modules in a fixed order. There is no parallel
React component tree.

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
RUN_DIR=runs/current-output
uv run cli run init "$RUN_DIR" --from-output
uv run cli derive --run-dir "$RUN_DIR"
install -m 0644 "$RUN_DIR/viewer-data/photos.geojson" viewer/static/data/photos.geojson
python build_similarity.py
```

Generate/update orphan exclusions (readiness-gated, gentle):

```bash
RUN="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="runs/recovery/orphans/$RUN"
uv run cli run init "$RUN_DIR" --from-output

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
  --raw-dir "$RUN_DIR/collect/raw_records" \
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
  - New key: `pair_distance` (defaults to `18`)
  - Pair schema unchanged: `group_id_a`, `group_id_b`, `distance`, `xid_a`, `xid_b`
  - Optional LLM-reviewed outputs add top-level `llm_review` metadata and per-pair
    `llm_verdict`, `llm_confidence`, `llm_reason`, `llm_model`, `llm_backend`
- `series_version_clusters.json`
  - Backward compatible keys: `generated_at`, `distance`, `hash_size`, `algo`, `clusters`
  - New key: `cluster_distance` (defaults to `32`)
  - Cluster schema unchanged: `series_id`, `version_id`, `xids`, `representative_xid`, `max_distance`

Similarity hashes use `algo: "dhash-edge-mountcrop"`: scans that look like
mounted prints are cropped to the central photo for hashing, then a 64-bit
luminance dHash and 64-bit edge-structure hash are combined. Distances are
Hamming distances over the combined 128-bit value. This keeps the duplicate
queue from over-ranking unrelated scans that only share black borders, beige
mounts, bright backgrounds, or broad horizontal tones.

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
- Two independent `split` votes put the series into the curator split queue.
- A curator split atomically moves the selected photographs, records the audit
  event, and consumes the votes that opened that review round. A later vote can
  start a new round without old votes resurfacing after a projection rebuild.
- The reset button on the page only clears the browser-local hide list; it does not delete backend votes.

Index page filtering behavior:
- Year slider + toggles filter the active dataset.
- Metadata search (`Hledat v metadatech fotek…`) further filters the same active dataset.
- Map markers, total count, and photo grid use the combined filter result.
- Address search mode (`Hledat adresu v Praze…`) does not filter photos; it only navigates the map.
- On fine-pointer devices, map preview thumbnails are prefetched for the nearest visible marker when the cursor moves close to it; the popup still opens only on hover.

Grouping rules:
- Metadata (`obsah + autor + datace`) suggests initial membership, but it is not
  the identity of a series.
- `viewer/build_geojson.py` creates an immutable `series_*` ID and preserves the
  published XID-to-series mapping across metadata changes, rebuilds, and fresh
  run-directory outputs.
- Curator overrides in D1 are versioned per XID and take precedence over the
  static mapping.
- Corrections apply to the group_id
- Version clusters are optional and come from `series_version_clusters.json`

## API endpoints (Cloudflare Pages Functions)

All endpoints live under `/api/*` (see `functions/api/*.js`).

- `GET /api/config` - Turnstile + archive base URL config + `fullResDownloadMode` (`client` on Pages Functions)
- `POST /api/verify` - Turnstile verification, sets session cookie
- `GET /api/review-state` - backend-resolved group roots + latest corrections + done groups
  - `?fresh=1` bypasses edge cache for immediate post-submit refresh
- `GET /api/corrections` - latest corrections (per group)
- `POST /api/corrections` - submit correction / flag; every `ok` confirmation
  must carry the displayed `location_revision` and matching `proposal_id` when
  a proposal exists, otherwise stale targets return `409`
- `GET /api/merges` - anonymous aggregate merge decisions and consensus counts
- `POST /api/merges` - submit merge decision (`same`, `different`, `undo` for last-vote revert)
  - `same` and `different` must carry the integer `candidate_revision` returned
    with the displayed candidate page; stale evidence returns `409` before any
    group IDs are resolved to newer roots.
  - `undo` targets the exact historical pair supplied by the client, even when
    another merge changed a member's current root, and needs no candidate
    revision.
  - `different` can also target that exact historical pair after consensus has
    resolved both members to one root.
- `GET /api/group-review-votes` - current per-voter series-review aggregation (`ok_votes`, `split_votes`, `done`, `needs_split`)
- `POST /api/group-review-votes` - submit series-review vote (`ok`, `split`, `undo`)
- `GET /api/community-candidates?flow=location|group|duplicate` - authoritative,
  paginated work queues. Responses contain at most 50 items; the contribution
  pages request 24–40 at a time instead of downloading the full photo corpus.
  Corrected features include `properties.original_coordinates`, allowing the
  client to restore their source position after membership changes or undo.
  Location candidates also carry the applied point separately from
  `proposed_id`, `proposed_lat`, `proposed_lon`, and `location_revision`, which
  binds a confirmation to the proposal the voter actually saw.
  `group_id` focuses the location flow on one exact current group and the
  duplicate flow on pairs containing that group; unknown groups return `400`.
  Cursors are bound to both the community-state revision and deployed static
  data version; a stale cursor returns `409`, and the browser restarts from a
  current first page instead of skipping or duplicating work.
- `GET /api/admin/review` - maintainer overview (pending corrections, flags,
  conflicts, split evidence and vote history, membership history, recent merges,
  public-state freshness, queue age, request failures, submissions, and
  contributor continuity)
- `POST /api/admin/session` - exchange the curator token for a signed, short-lived
  HttpOnly session cookie; the token is not kept in browser storage
- `GET /api/admin/groups?query=...` - bounded curator search for an existing
  destination series by ID, XID, description, signature, author, or date
- `GET /api/admin/export?format=json|csv&since=...&limit=...` - maintainer export
  (projected group state is included only when both its D1 revision and deployed
  data version are current)
  - filtering/order/limit run in D1; JSON reports `groupStateCurrent=false`
    instead of scanning all history when the materialized group state is stale
- `POST /api/admin/group-membership` - atomically move selected XIDs into a new
  or existing series and append a curator audit event. A complete source series
  may move only into an existing destination, which makes mistaken splits
  reversible without allowing an accidental rename into a new empty series.
- `GET /api/preview-url?xid=...` - preview URL resolver (R2 tile probe -> feature preview/zoomify fallback)
- `GET /api/preview-local?xid=...&scanIndex=0` - serve local preview file from `downloads/archive/previews`
- `GET /api/zoomify?xid=...&scanIndex=0` - server-side Zoomify metadata
  - Uses R2 if `R2_TILES_BASE` is set and the scan exists there.
- `GET /api/dezoomify?xid=...&scanIndex=0` - FastAPI-only full-resolution JPEG download (tile stitch on server)

Write API hardening:
- `viewer/static/_headers` applies a deny-by-default CSP plus frame, MIME,
  referrer, camera, microphone, and browser-geolocation restrictions to Pages
  responses while allowing the archive imagery and iframe, map tiles, fonts,
  Turnstile, and common public R2 hostnames the public flows require. Leaflet,
  MarkerCluster, and OpenSeadragon are bundled into the release instead of
  loaded from a third-party CDN. A custom `R2_TILES_BASE` hostname must also be
  added to the CSP before it is enabled.
- `POST /api/verify`, `POST /api/corrections`, `POST /api/merges`, `POST /api/group-review-votes` require same-origin (`Origin`/`Referer` match).
- Per-IP rate limits are enforced in D1.
- Turnstile verification checks `success`, `hostname`, and expected `action`.
- An anonymous contributor receives a signed, HttpOnly one-year voter cookie.
  Turnstile sessions may expire without changing that contributor's consensus identity.
- Admin APIs require `ADMIN_API_TOKEN`. The workbench exchanges it for a signed,
  short-lived HttpOnly cookie; bearer authentication remains available for
  release tooling. Cloudflare Access is an additional edge layer, not a
  substitute for application authentication. PII and voter fingerprints are
  not returned by public state endpoints or operational aggregates.
- Protect `/admin*` and `/api/admin/*` with Cloudflare Access as an additional edge layer.
- The curator workbench shows photo evidence before a split, searches existing
  destination series without downloading the whole catalog, and uses an inline
  confirmation before recording a reversal as a new membership event.
- Typical failures: `403` origin mismatch/missing, `429` rate limit exceeded (`Retry-After`), `400` invalid Turnstile action/hostname.

## Local development (FastAPI)

FastAPI serves the static app and stores corrections locally in JSONL files:

- `viewer/data/corrections.jsonl`
- `viewer/data/merges.jsonl`
- `viewer/data/group_review_votes.jsonl`
- `viewer/data/group_membership_events.jsonl` (append-only curator membership
  moves plus vote-resolution boundaries)
- `viewer/data/feedback.jsonl`

Run:

```bash
npm run dev
```

Open `http://127.0.0.1:8000`.

Turnstile bypass is local-only: `TURNSTILE_BYPASS=1` is honored only on `localhost`/`127.0.0.1`/`::1`.

## Local development (Cloudflare Pages + D1)

For the production-like local path, run:

```bash
npm run dev:pages
```

This applies local D1 migrations, runs the Vite/static watcher in the background,
and starts Wrangler Pages. Open the URL printed by Wrangler, typically
`http://127.0.0.1:8788`.

## Browser end-to-end tests

Install the pinned Chromium build once, then run the production-like community
flow suite:

```bash
npx playwright install chromium
npm run test:e2e
```

The suite builds the viewer, applies every D1 migration to a fresh temporary
database, and starts a local Pages runtime. It covers location correction,
duplicate decisions and undo, two-contributor split consensus plus curator
reassignment, failed-request recovery, stale cursors, and keyboard-contained
correction dialogs. The temporary database is removed after the run; the suite
does not use a developer database or any remote Cloudflare environment.

## Cloudflare Pages + D1

### 1) Create databases

```bash
npx wrangler login
npx wrangler d1 create old-prague-photos
npx wrangler d1 create old-prague-photos-staging --location weur
```

Update the production and `env.preview` entries in `wrangler.toml` with their
distinct `database_id` values. The checked-in all-zero preview UUID is an
intentional fail-closed value: staging deployment cannot run until it is
replaced.

### 2) Run migrations

```bash
npx wrangler d1 migrations apply CORRECTIONS_DB --local
npx wrangler d1 migrations apply CORRECTIONS_DB --remote
npx wrangler d1 migrations apply CORRECTIONS_DB --remote --env preview
```

### 3) Local Pages dev

```bash
npm run dev:pages
```

### 4) Deploy to staging

Configure a stable staging hostname, separate Turnstile keys and hostname
allowlist, a hostname-restricted Mapy.cz browser key, `ADMIN_API_TOKEN`, and a
Cloudflare Access policy. The smoke check requires a Cloudflare Access service
token so it can prove that anonymous admin requests are blocked and authorized
requests reach the application.

```bash
PAGES_STAGING_URL=https://staging.example.com \
D1_BACKUP_DIR=/secure/retained/old-prague-photos \
ADMIN_API_TOKEN=... \
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
CONFIRM_STAGING_DEPLOY=old-prague-photos-staging \
npm run deploy:pages:staging
```

This captures a private preview-D1 export and Time Travel bookmark, applies
migrations only to the preview database, deploys the `staging` branch preview,
and checks configuration, all three candidate queues, Access, and the curator
API. The command fails before remote work unless the worktree is clean and the
staging URL, checkpoint destination, confirmation, and smoke credentials are
present.

### 5) Deploy to production

Use the guarded release command. It runs Python/API/real-D1 tests, builds the
frontend, captures a private SQL export and Time Travel bookmark, applies
additive migrations remotely, deploys Pages, and runs the same smoke checks:

```bash
D1_BACKUP_DIR=/secure/retained/old-prague-photos \
PAGES_PRODUCTION_URL=https://example.com \
ADMIN_API_TOKEN=... \
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
CONFIRM_PRODUCTION_DEPLOY=old-prague-photos \
npm run deploy:pages
```

Do not deploy the Functions separately before migrations `0009` through `0013`.
The migration-first sequence is backward compatible with the previous code; the
reverse sequence is not.

See `docs/RELEASING.md` for the complete secret, Access, backup, rollback, and
post-release checklist.

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
- `ADMIN_API_TOKEN` (required for admin APIs)
- `ADMIN_SESSION_TTL_SECONDS` (optional curator-session lifetime; defaults to
  `28800`, bounded to 15 minutes–24 hours)
- `COMMUNITY_DATA_VERSION` (optional explicit projection-version override).
  Normal builds generate `/data/community-data-version.json` from every static
  input used by the community queues. Functions require that nonempty,
  deployment-bound version and fail closed if it is missing, so an asset-only
  Pages deployment cannot reuse a projection built for older group/XID data.
- `ARCHIVE_BASE_URL` (optional)
- `R2_TILES_BASE` (optional; points to public R2 prefix with tiles)
- `MAPY_CZ_API_KEY` (optional public browser tile key; restrict it to the
  production/local origins in Mapy.cz and rotate any previously committed key)
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
- D1 stores append-only contribution events, current merge/vote projections,
  versioned group membership overrides, a revisioned public-state snapshot, and
  bounded hourly request-outcome counters. The curator workbench combines those
  counters with aggregate event queries to show stale cursors, failures,
  submission volume, queue age, and new/returning contributors without exposing
  contributor identities. Hourly counters are retained for 90 days.
- Candidate delivery is a bounded read model shared by Pages and the FastAPI
  compatibility runtime. It applies current merges, membership overrides,
  corrections, and orphan filtering before pagination. Duplicate candidates
  prioritize similarity pairs and cap exact-coordinate expansion at eight
  neighbors per group, avoiding quadratic all-pairs queues for large buckets.
  Similarity pairs follow their referenced XIDs through curator membership
  moves rather than trusting the group IDs captured when the artifact was built.
  Version-cluster XIDs are likewise filtered and reattached to their current
  series, with per-series version labels regenerated after curator moves.
- Candidate cursor revisions include effective XID membership in both Pages and
  FastAPI, so moving members between already-existing series invalidates old
  offsets instead of skipping or repeating work.
- A write marks the public snapshot dirty. The next review-state read rebuilds
  against a captured revision and only publishes the snapshot if no concurrent
  write changed that revision. Warm reads do not scan contribution history.
- `review-state` includes consensus metadata per group:
  - `correction_state`: `none | pending | approved`
  - `anchor_type`: `none | flag | correction`
  - `ok_votes`, `required_ok_votes`, `done`, `needs_confirmation`
- UI copy is Czech-only (templates in `viewer/react/src/templates/*.html` + runtime logic in `viewer/static/*.js`).

## Verification

- `npm run test:api` exercises API contracts, failure behavior, durable voter
  identity, split consensus, admin auth, and the curator assignment endpoint.
- `npm run test:d1` applies every migration to a fresh real local D1 database
  and asserts the projection triggers.
- `npm test` runs Python, API, and real-D1 coverage.
