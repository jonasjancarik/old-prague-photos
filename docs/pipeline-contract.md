# Pipeline Contract

Read this when:
- you need to run or reproduce the non-web data pipeline
- you are deciding whether a script is part of the supported pipeline surface
- you are changing collection, filtering, geolocation, export, GeoJSON, or manifests
- you need to prove that ignored caches were preserved without reprocessing them

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

Batch submission writes the request plus a local intent/reservation before any
remote call. Unfinished reservations prevent the same record from being
submitted again after an interruption. An interrupted request upload resumes
from the saved, checksummed request. Once remote job creation starts, the intent
remains in `LOCAL_CREATE_PENDING`: creation is not retried automatically because
the remote job may already exist. After verifying the corresponding Gemini job
name and deterministic display name, attach it explicitly without resubmitting:

```bash
uv run cli run geolocate-llm reconcile "$RUN_DIR" \
  local/<request-fingerprint> batches/<remote-job-id>
```

The reconciliation command preserves the intent's record reservation unless
the remote job identity matches. Processing accepts a downloaded result only
when every key is a nonempty canonical string (with no surrounding whitespace)
and the unique key set exactly matches the saved request keys; invalid, missing,
duplicate, or unexpected keys fail the stage without marking it processed.

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

`stage_log.jsonl` records completed run stages. `manifest.json` records artifact
hashes plus a sorted per-file inventory, byte count, and aggregate digest for
each run directory, along with git state and non-secret environment settings.

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

`init --from-output` refuses a nonempty run directory, so importing a snapshot
cannot overwrite earlier run state. Derived outputs for that snapshot are
written under the run directory. Collection keeps `failed_xids.jsonl` as an
append-only attempt history rather than clearing it before a retry; a successful
raw-record save appends a resolution only when that record's latest event is
still unresolved. Navigation resume caches use schema v2 with the exact label
and seed URL. Matching nonempty legacy partitions remain resumable, but an empty
partition is retried unless an explicit reported total of zero confirms it.

Export combines the latest run-local raw metadata with saved geolocation
results. Current raw fields take precedence, the existing geolocation object is
retained, and a geolocation record remains exportable when its raw sidecar is
missing.

Validate a completed run without changing either the run or published data:

```bash
uv run cli run validate runs/<run-id>
```

Validation rejects missing inputs, invalid or mismatched record JSON, malformed
or empty viewer data, duplicate or unstable feature IDs, and viewer features
without a matching geolocation result. Publication invokes the same validation
before staging any files.

To intentionally publish a completed run back to the compatibility snapshot
and the web dataset, use:

```bash
uv run cli run publish runs/<run-id>
```

Publication is additive: matching raw, successful-geolocation, and failed-record
JSON objects are recursively merged, so published fields omitted by the run are
retained while explicit incoming values win. Viewer features replace matching
IDs, while records omitted from the run remain in place. Gemini requests and
results are immutable by filename: an identical copy is accepted, but differing
bytes fail publication instead of overwriting remote-work provenance. ID lists,
failure attempts, navigation progress, batch metadata, and prompts are merged
rather than truncated. A partial run therefore cannot silently prune the
compatibility snapshot.

The orphan-recovery loop uses this only when `UPDATE_TRACKED_DATASETS=1`, and
publishes the matching orphan list only after the snapshot succeeds.

## Ignored caches are verified without running the pipeline

The committed release baseline inventories expensive ignored files that would
otherwise require downloads, image stitching, or model review to recreate. It
covers the stitched similarity cache, candidate-rescore cache, archive download
cache, evaluation and orphan-recovery media, and superseded similarity cache
backups. Disposable `.DS_Store` files are excluded from the archive cache. The
baseline also intentionally excludes `.wrangler/`, D1 data, environment files,
credentials, and local community contribution logs.

Verify the current files without changing them:

```bash
uv run python scripts/release_baseline_inventory.py verify \
  data-snapshots/release-baseline-2026-08-11.json
```

Each target contains a sorted per-file SHA-256 inventory, total file count,
total bytes, and an aggregate digest. The aggregate is SHA-256 over canonical
UTF-8 JSON Lines containing `path`, `sha256`, and `size_bytes`, ordered by path.
`absent_paths` is always present, so a missing selected directory or file cannot
be mistaken for an empty cache.

Verification failure is a preservation stop, not an instruction to rebuild.
First copy the current cache to retained storage, then compare the added,
removed, or changed paths reported by the command. Only write a replacement
baseline after the difference is understood and approved:

```bash
uv run python scripts/release_baseline_inventory.py write \
  --output data-snapshots/release-baseline-2026-08-11.json
```

Writing the manifest hashes existing bytes only. It does not collect records,
download archive media, stitch images, invoke a model, or modify corpus files.

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
