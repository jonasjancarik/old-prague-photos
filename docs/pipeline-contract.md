# Pipeline Contract

Read this when:
- you need to run or reproduce the non-web data pipeline
- you are deciding whether a script is part of the supported pipeline surface
- you are changing collection, filtering, geolocation, export, GeoJSON, or manifests

The canonical non-web pipeline is run-directory based. Reproducible work should
target a named run directory. Historical `output/` snapshots can be imported
into a run directory, but `output/` is not the operator contract.

Pipeline implementation code lives under `src/pipeline/`. Root-level Python
files should be limited to the `cli.py` entrypoint and explicitly inventoried
maintenance tools. Root-level pipeline modules are intentionally unsupported.

## Canonical Run

```bash
RUN_DIR=runs/$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE_RECORD_DELAY_S=5 CONCURRENT_REQUESTS=1 uv run cli run pipeline "$RUN_DIR"
```

This synchronous command covers:
- archive ID collection and raw record scraping
- run-local filtering
- Mapy.cz geolocation
- deterministic derived outputs: CSV, GeoJSON, manifest

The asynchronous Gemini Batch stage is intentionally separate:

```bash
uv run cli run geolocate-llm submit "$RUN_DIR" --include-failed-cp
uv run cli run geolocate-llm status "$RUN_DIR"
uv run cli run geolocate-llm collect "$RUN_DIR"
uv run cli run geolocate-llm process "$RUN_DIR"
uv run cli derive --run-dir "$RUN_DIR"
```

## Run Directory Layout

```text
runs/<run-id>/
  config.json
  manifest.json
  stage_log.jsonl
  collect/
    available_record_ids.json
    failed_xids.jsonl
    missing_details_xids.json
    nav_partition_progress.json
    raw_records/*.json
  filter/
    records_with_cp.json
    records_with_cp_in_record_obsah.json
    records_without_cp.json
    records_without_dilo.json
    records_with_places.json
  geolocation/
    ok/*.json
    failed/**/*.json
    llm/
      batches.json
      prompts.json
      batch_requests/*.jsonl
      batch_results/*.jsonl
  export/
    old_prague_photos.csv
  viewer-data/
    photos.geojson
    similarity_candidates.json
    series_version_clusters.json
```

`stage_log.jsonl` records completed run stages. `manifest.json` records file
hashes, directory counts, git state, and non-secret environment settings.

## Supported Surfaces

The supported operator surface is:
- `uv run cli run ...` for reproducible run-directory work
- `uv run cli derive --run-dir ...` for deterministic rebuilds from a run snapshot
- scripts explicitly listed in [Script Inventory](./script-inventory.md)

If a new top-level script, `scripts/*` helper, or `research/*` helper is added,
classify it in `docs/script-inventory.md`. The test suite enforces this.

## Historical Output Snapshots

The old top-level `output/` pipeline commands are intentionally not supported.
To preserve or inspect a historical `output/` snapshot, seed a run directory:

```bash
uv run cli run init runs/current-output --from-output
uv run cli derive --run-dir runs/current-output
```

Derived outputs for that snapshot are written under the run directory.

## Verification

Before handing off non-web pipeline changes, run:

```bash
npm test
npm run build:viewer
git diff --check
```

For no-network smoke coverage of the orchestration layer:

```bash
RUN_DIR=$(mktemp -d /tmp/opp-run-XXXXXX)
uv run cli run pipeline "$RUN_DIR" --skip-collect --skip-mapy --no-derive
test -f "$RUN_DIR/manifest.json"
test -f "$RUN_DIR/stage_log.jsonl"
```
