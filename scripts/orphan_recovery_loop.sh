#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

LOOP_ID="${1:-$(date +%Y%m%d-%H%M%S)-loop}"
LOOP_DIR="output/recovery/orphans/${LOOP_ID}"
LOOP_LOG="${LOOP_DIR}/loop.log"
HISTORY_FILE="${LOOP_DIR}/history.jsonl"
STATE_FILE="${LOOP_DIR}/loop_state.json"
STOP_FILE="${STOP_FILE:-output/recovery/orphans/STOP_LOOP}"
ORPHAN_LIST_PATH="${ORPHAN_LIST_PATH:-viewer/static/data/orphan_xids.json}"
PHOTOS_GEOJSON_PATH="${PHOTOS_GEOJSON_PATH:-viewer/static/data/photos.geojson}"

PROBE_MIN_INTERVAL="${PROBE_MIN_INTERVAL:-15}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-12}"
PROBE_RETRIES="${PROBE_RETRIES:-0}"
PROBE_RETRY_SLEEP="${PROBE_RETRY_SLEEP:-20}"
COLLECT_PASSES="${COLLECT_PASSES:-2}"
COLLECT_DELAY="${COLLECT_DELAY:-5}"
COLLECT_CONCURRENCY="${COLLECT_CONCURRENCY:-1}"
SLEEP_BETWEEN_CYCLES="${SLEEP_BETWEEN_CYCLES:-120}"
SLEEP_AFTER_ERROR="${SLEEP_AFTER_ERROR:-300}"
MAX_CYCLES="${MAX_CYCLES:-0}"
RUN_SIMILARITY_ON_COMPLETE="${RUN_SIMILARITY_ON_COMPLETE:-1}"
UPDATE_TRACKED_DATASETS="${UPDATE_TRACKED_DATASETS:-0}"

mkdir -p "$LOOP_DIR"
: > "$LOOP_LOG"

echo "$LOOP_DIR" > output/recovery/orphans/LATEST_LOOP

log() {
  local msg="$1"
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$msg" | tee -a "$LOOP_LOG"
}

write_state() {
  local status="$1"
  local cycle="$2"
  local run_dir="$3"
  cat > "$STATE_FILE" <<JSON
{
  "timestamp": "$(date -u +%FT%TZ)",
  "status": "${status}",
  "cycle": ${cycle},
  "loop_dir": "${LOOP_DIR}",
  "run_dir": "${run_dir}",
  "stop_file": "${STOP_FILE}"
}
JSON
}

run_cmd() {
  local step="$1"
  shift
  log "step=${step}"
  "$@" >> "$LOOP_LOG" 2>&1
}

cycle=0
log "loop_start loop_id=${LOOP_ID} probe_min_interval=${PROBE_MIN_INTERVAL}s probe_retries=${PROBE_RETRIES} collect_delay=${COLLECT_DELAY}s collect_passes=${COLLECT_PASSES} update_tracked_datasets=${UPDATE_TRACKED_DATASETS} orphan_list_path=${ORPHAN_LIST_PATH}"

while true; do
  if [ -f "$STOP_FILE" ]; then
    write_state "stopped" "$cycle" ""
    log "stop_file_detected path=${STOP_FILE}"
    exit 0
  fi

  if [ "$MAX_CYCLES" -gt 0 ] && [ "$cycle" -ge "$MAX_CYCLES" ]; then
    write_state "max_cycles_reached" "$cycle" ""
    log "max_cycles_reached max=${MAX_CYCLES}"
    exit 0
  fi

  cycle=$((cycle + 1))
  RUN_ID="$(date +%Y%m%d-%H%M%S)-c${cycle}"
  RUN_DIR="${LOOP_DIR}/${RUN_ID}"
  mkdir -p "$RUN_DIR"
  echo "$RUN_DIR" > output/recovery/orphans/LATEST_RUN
  write_state "running" "$cycle" "$RUN_DIR"
  log "cycle_start cycle=${cycle} run_dir=${RUN_DIR}"

  cycle_ok=1

  run_cmd "probe" uv run python scripts/orphan_recovery.py probe \
    --input "$ORPHAN_LIST_PATH" \
    --run-dir "$RUN_DIR" \
    --min-interval "$PROBE_MIN_INTERVAL" \
    --timeout "$PROBE_TIMEOUT" \
    --retries "$PROBE_RETRIES" \
    --retry-sleep "$PROBE_RETRY_SLEEP" || cycle_ok=0

  run_cmd "seed-retry" uv run python scripts/orphan_recovery.py seed-retry \
    --run-dir "$RUN_DIR" \
    --failed-file output/failed_xids.jsonl || cycle_ok=0

  pass=1
  while [ "$pass" -le "$COLLECT_PASSES" ]; do
    run_cmd "collect-pass-${pass}" env ARCHIVE_RECORD_DELAY_S="$COLLECT_DELAY" CONCURRENT_REQUESTS="$COLLECT_CONCURRENCY" uv run cli collect --retry-failed || cycle_ok=0
    pass=$((pass + 1))
  done

  if [ "$UPDATE_TRACKED_DATASETS" -eq 1 ]; then
    run_cmd "backfill-scan-metadata" uv run python scripts/backfill_scan_metadata.py || cycle_ok=0
    run_cmd "export" uv run cli export || cycle_ok=0
    run_cmd "build-geojson" uv run python viewer/build_geojson.py || cycle_ok=0
  else
    log "skip_dataset_refresh update_tracked_datasets=${UPDATE_TRACKED_DATASETS}"
  fi

  run_cmd "build-subset" uv run python scripts/orphan_recovery.py build-subset \
    --run-dir "$RUN_DIR" \
    --photos "$PHOTOS_GEOJSON_PATH" || cycle_ok=0

  run_cmd "finalize" uv run python scripts/orphan_recovery.py finalize \
    --run-dir "$RUN_DIR" \
    --photos "$PHOTOS_GEOJSON_PATH" \
    --raw-dir output/raw_records \
    --downloads-root downloads/archive \
    --output-orphans "$ORPHAN_LIST_PATH" || cycle_ok=0

  if [ "$cycle_ok" -ne 1 ]; then
    printf '{"timestamp":"%s","cycle":%s,"run_dir":"%s","status":"error"}\n' "$(date -u +%FT%TZ)" "$cycle" "$RUN_DIR" >> "$HISTORY_FILE"
    write_state "error" "$cycle" "$RUN_DIR"
    log "cycle_error cycle=${cycle} sleep_after_error=${SLEEP_AFTER_ERROR}s"
    sleep "$SLEEP_AFTER_ERROR"
    continue
  fi

  transient_count="$(jq 'length' "$RUN_DIR/probe_transient.json")"
  active_count="$(jq 'length' "$RUN_DIR/probe_active.json")"
  not_found_count="$(jq 'length' "$RUN_DIR/probe_not_found.json")"
  orphan_count="$(jq 'length' "$ORPHAN_LIST_PATH")"

  printf '{"timestamp":"%s","cycle":%s,"run_dir":"%s","status":"ok","active":%s,"not_found":%s,"transient":%s,"orphans":%s}\n' \
    "$(date -u +%FT%TZ)" "$cycle" "$RUN_DIR" "$active_count" "$not_found_count" "$transient_count" "$orphan_count" >> "$HISTORY_FILE"

  log "cycle_done cycle=${cycle} active=${active_count} not_found=${not_found_count} transient=${transient_count} orphans=${orphan_count}"

  if [ "$transient_count" -eq 0 ]; then
    log "all_transients_cleared cycle=${cycle}"
    if [ "$RUN_SIMILARITY_ON_COMPLETE" -eq 1 ]; then
      if [ -f .env ]; then
        set -a
        # shellcheck disable=SC1091
        source .env
        set +a
      fi
      if [ -n "${R2_TILES_BASE:-}" ]; then
        run_cmd "similarity-full" uv run python build_similarity.py --r2-tiles-base "$R2_TILES_BASE" || true
      else
        log "similarity_skipped reason=R2_TILES_BASE_missing"
      fi
    fi
    write_state "complete" "$cycle" "$RUN_DIR"
    exit 0
  fi

  write_state "sleeping" "$cycle" "$RUN_DIR"
  log "sleep_between_cycles seconds=${SLEEP_BETWEEN_CYCLES}"
  sleep "$SLEEP_BETWEEN_CYCLES"
done
