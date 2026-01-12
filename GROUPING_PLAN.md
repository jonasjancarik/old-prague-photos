# Grouping Plan (Series / Versions / Scans)

Hi Jonas — solid direction; this will compound.

## Scope

Goal: build reliable grouping for historical photo records with three layers:

- Record: single archive XID (permalink). Own metadata.
- Scan: multiple images under one XID (scanIndex=0..N-1). Archive‑provided; reliable.
- Version: same shot across XIDs (visual similarity). Auto‑suggested; needs review.
- Series: metadata grouping (obsah + autor + datace). Curated by humans; higher‑level grouping.

We keep all layers; UI shows them distinctly so reviewers know what is “archive‑confirmed” vs “suggested”.

## Definitions

- **Series (Série)**: metadata group computed from `obsah + autor + datace`. This is the current grouping key. It can include multiple different shots from the same session. Needs manual review to classify into versions.
- **Version (Verze)**: visually same shot (different scan, crop, tone, skew). Derived from perceptual hash clusters inside a Series. Can be auto‑suggested, but should be labeled “auto”.
- **Scan (Sken)**: archive scanIndex under a single XID, i.e. `permalink?xid=...&scan=1#scan1`. This is archive‑provided and should be treated as reliable “same shot” within one record.

## Data Sources

Archive provides:

- Permalink page (`/permalink?xid=...`): metadata fields; “N obrázky” indicates scan count; Zoomify link with `scanIndex=0`.
- Zoomify page (`Zoomify.action?...&scanIndex=k`): `zoomifyImgPath` for that scan.
- Preview images: derived from `zoomifyImgPath` by replacing `/zoomify/` with `/image/` and appending `/nahled_maly.jpg` or `/nahled_stredni.jpg`.

We will capture:

- `scan_count` from the text `N obrázky` on permalink.
- `scan_indices` (0..N-1) by enumeration.
- `scan_previews`: list of preview URLs per scanIndex (small or medium).
- `scan_zoomify_paths`: list of zoomifyImgPath per scanIndex.

## Data Model (Storage)

Raw record JSON (`output/raw_records/<xid>.json`): add fields

- `scan_count`: int
- `scan_indices`: array of ints
- `scan_previews`: array of URLs (one per scanIndex)
- `scan_zoomify_paths`: array of URLs (one per scanIndex)
- `has_scans`: boolean (scan_count > 1)

CSV export (`output/old_prague_photos.csv`): add columns

- `scan_count`
- `scan_previews` (JSON string array)
- `scan_zoomify_paths` (JSON string array)

GeoJSON (`viewer/static/data/photos.geojson`): add props

- `scan_count`: int
- `scan_previews`: array
- `scan_zoomify_paths`: array
- keep `group_id` (Series key) consistently

Notes:

- Avoid breaking current consumers; new fields optional.
- Use JSON string for CSV fields; keep GeoJSON as native arrays.

## Scraper Changes

Location: `src/scraper/record_scraper.py`

Steps per XID:

1. Fetch permalink HTML (already done).
2. Parse item rows (metadata) — existing.
3. Parse scan count:
   - Regex for `(\d+)\s+obrázk` in permalink HTML.
   - If missing, set scan_count=1 by default (or 0 when no preview).
4. Get Zoomify link from permalink HTML (existing in app; add to scraper).
5. For each scanIndex in `0..scan_count-1`:
   - Request Zoomify page for that scanIndex.
   - Extract `zoomifyImgPath`.
   - Derive preview URL: replace `/zoomify/` → `/image/`, append `/nahled_maly.jpg`.
6. Persist fields into raw record JSON.

Network load:

- Cache: only rescrape when `RESCRAPE_EXISTING_RECORDS=1`.
- Throttle requests if needed (sleep or semaphore bound).
- Avoid fetching any tile data here; only HTML for Zoomify + small preview URLs.

## Build Pipeline Changes

`viewer/build_geojson.py`

- Ensure `group_id` always present in properties.
- Add scan fields to properties if available in CSV.
- Keep backwards compatibility with old CSVs (missing columns → empty arrays).

Optional: Add a small helper in export to include new columns; if export is not changed, map from raw_records to CSV before geojson build.

## Hashing (Visual Similarity)

Script: `build_similarity.py`

Change source:

- Use preview images instead of Zoomify tiles. Prefer `nahled_maly.jpg`.
- If preview list exists, pick scanIndex=0 by default; or compute hash per scan when `scan_count > 1` and select minimal distance across scans.

Algorithm:

- Perceptual dHash (already implemented) with hash_size=8.
- Use preview image downsampling (already small), no HQ downloads.
- Build BK-tree for nearest neighbors.

Clustering:

- Perform clustering **within each Series** (same group_id).
- For each Series, cluster XIDs by Hamming distance threshold.
- Output clusters as “Version” groups with label “auto”.

Output file:

- `viewer/static/data/similarity_candidates.json` (already exists) or new file `series_version_clusters.json`.
- Include:
  - `series_id` (group_id)
  - `version_id` (cluster hash or index)
  - `xids` list
  - `representative_xid`
  - `max_distance` within cluster

## UI Plan (Group Review)

New UI concepts:

- “Série” = metadata group (current group id).
- “Verze” = visual cluster within a Série.
- “Skeny” = scanIndex variants under a single XID.

Pages:

1. **Group Review** (existing `group-review.html`):
   - Show Series header, count of versions, count of scans (if any).
   - UI split: left preview viewer, right metadata + version/scan pills.
   - Filters: show only Series with >1 XID, or only with >1 Version.

2. **Dup Review** (existing `dup-review.html`):
   - Keep for cross‑Series similarity or same‑coordinate merges.
   - Show source label: “shodná poloha” vs “vizuální podobnost”.

UI components:

- Version pills (clustered list). Clicking switches XID.
- Scan pills (scanIndex list). Clicking changes archive URL or zoomify request.
- Labels:
  - “Série” (metadata).
  - “Verze (auto)” for visual cluster suggestions.
  - “Skeny (archiv)” for scanIndex.

Viewer behavior:

- Archive iframe URL: `permalink?xid=...&scan=<idx>#scan<idx>`.
- Zoomify API: add `scanIndex` param (default 0) to `/api/zoomify`.
- Store selected scanIndex in state for each XID.

## API Changes

`/api/zoomify` (FastAPI + CF Workers):

- Add query param `scanIndex` (int, default 0).
- Use scanIndex when resolving Zoomify URL.
- Cache key should include scanIndex.

Optional: `/api/config` can expose if scans are available, but not required.

## Migration / Backfill

- Rescrape raw records with `RESCRAPE_EXISTING_RECORDS=1` to add scan fields.
- Re‑export CSV + GeoJSON.
- Run `build_similarity.py` to generate version clusters.

No destructive changes to corrections or merges.

## Validation Checklist

Scrape:

- Spot‑check 5 records with `N obrázky` to confirm scan counts and previews.
- Confirm `scanIndex=0..N-1` returns unique preview URLs when applicable.

Data:

- GeoJSON contains `group_id`, `scan_count`, `scan_previews`.
- Group Review page shows Series with >1 XID.

UI:

- Scan pills switch archive iframe and zoom viewer.
- Version pills switch to different XID and update metadata.
- Labels show “Série / Verze / Skeny” clearly.

Hashing:

- Small preview only; no HQ tiles fetched.
- Threshold tuned on a small set (e.g., 50 Series) to avoid over‑grouping.

## Risks / Edge Cases

- `scan_count` text missing on some pages → default to 1.
- Some scanIndex may point to identical zoomifyImgPath; still OK (duplicate scans).
- Preview URLs might 404; fallback to zoomify tile or skip hash.
- Visual hashing can merge distinct shots with similar composition; label “auto” and require review.

## Work Breakdown (Suggested order)

1. Scraper: scan_count + scanIndex enumeration + preview URLs.
2. Export/GeoJSON: add scan fields and enforce group_id.
3. API: add scanIndex to `/api/zoomify`.
4. UI: update Group Review to show Series + Version + Scan pills.
5. Hash pipeline: preview‑based hashing + per‑Series clustering.
6. Ops: rescrape + rebuild CSV/GeoJSON + run similarity build.

