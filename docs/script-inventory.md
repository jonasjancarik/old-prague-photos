# Script Inventory

Read this when:
- you find a root-level script or `scripts/*` helper and need to know whether it is supported
- you want to add a new loose script
- you are deciding whether loose script behavior belongs in the run-directory pipeline

Status meanings:
- `canonical`: preferred operator entrypoint
- `maintenance`: supported helper for cache, recovery, metadata, or deployment maintenance
- `research`: preserved experiment or probe; not part of the supported pipeline

| Path | Status | Category | Use |
| --- | --- | --- | --- |
| `cli.py` | canonical | pipeline | Typer entrypoint. Prefer `uv run cli run ...` for reproducible pipeline runs. |
| `viewer/build_geojson.py` | maintenance | pipeline/viewer-data | Importable GeoJSON builder used by run-directory derivation and viewer-data maintenance. |
| `viewer/community_candidates.py` | maintenance | web-runtime | Shared bounded candidate builder for the FastAPI compatibility runtime. |
| `viewer/local_membership.py` | maintenance | web-runtime | Applies append-only local curator membership events and their group-review resolution boundaries for FastAPI parity. |
| `build_similarity.py` | maintenance | viewer-data | Builds similarity candidates and version clusters. Inputs/outputs are configurable; default outputs target viewer static data. |
| `download_archive_images.py` | maintenance | asset-cache | Gentle/resumable archive preview and Zoomify tile cache downloader. |
| `dezoomify.py` | maintenance | asset-cache | Zoomify resolver/stitcher used by archive download and viewer preview flows. |
| `scripts/backfill_scan_metadata.py` | maintenance | metadata | Copies scan metadata from raw records into geolocated records after rescrapes. |
| `scripts/write_pipeline_manifest.py` | maintenance | reproducibility | Manifest writer used by run-directory derivation. |
| `scripts/orphan_recovery.py` | maintenance | recovery | Gentle orphan xid probe/finalize workflow with readiness gates. |
| `scripts/orphan_recovery_loop.sh` | maintenance | recovery | Shell wrapper for repeated orphan recovery passes. |
| `scripts/llm_review_similarity.py` | maintenance | review | LLM review/materialization for visual duplicate candidates. |
| `scripts/r2_sync.sh` | maintenance | deployment | Syncs archive tile/previews cache to R2-compatible storage. |
| `scripts/dev.sh` | maintenance | development | Local development helper. |
| `scripts/dev-pages.sh` | maintenance | development | Cloudflare Pages local development helper. |
| `scripts/test-d1.sh` | maintenance | testing | Applies all migrations to a fresh local D1 instance and runs projection trigger assertions. |
| `scripts/update-community-data-version.mjs` | maintenance | build/deployment | Hashes every static community-queue input into the deployment-bound projection/cache version manifest. |
| `scripts/deploy-pages.sh` | maintenance | deployment | Runs the full gate, builds the viewer, applies remote D1 migrations, then deploys Pages. |
| `ops.sh` | maintenance | development/deployment | Legacy local ops wrapper for viewer build/dev/deploy tasks. |
| `research/ahmp_limit/probe_filters.py` | research | archive-limit | AHMP result-limit research probe; not part of reproducible pipeline runs. |
| `research/ahmp_limit/nav_partition.py` | research | archive-limit | Early nav-partition experiment; supported implementation is `src/scraper/nav_partition.py`. |
New loose scripts must be added to this table with an explicit status. Prefer
adding importable code under `src/` and exposing it through `cli.py` or
`src/pipeline/cli_run.py` instead of creating a new root-level script.
