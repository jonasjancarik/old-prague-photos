#!/bin/sh
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

usage() {
  cat <<'USAGE'
Usage: scripts/seed-catalog-d1.sh [production|preview] [--dry-run]

Builds a temporary catalog seed and applies it to the selected CORRECTIONS_DB
D1 database. CLOUDFLARE_ACCOUNT_ID is required. --dry-run only builds and
validates the local seed; it does not contact Cloudflare.
USAGE
}

DRY_RUN=0
TARGET=production
while [ "$#" -gt 0 ]; do
  case "$1" in
    production|preview)
      TARGET=$1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$DRY_RUN" -eq 0 ] && [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "Set CLOUDFLARE_ACCOUNT_ID before seeding D1." >&2
  exit 2
fi
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  export CLOUDFLARE_ACCOUNT_ID
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to build and validate the catalog seed." >&2
  exit 2
fi
if [ "$DRY_RUN" -eq 0 ] && ! command -v npx >/dev/null 2>&1; then
  echo "npx is required to seed the production D1 database." >&2
  exit 2
fi

run_wrangler() {
  (
    cd "$ROOT_DIR"
    if [ "$TARGET" = preview ]; then
      CI=1 npx wrangler "$@" --env preview
    else
      CI=1 npx wrangler "$@"
    fi
  )
}

umask 077
SEED_DIR=$(mktemp -d "${TMPDIR:-/tmp}/old-prague-catalog-seed.XXXXXX")
cleanup() {
  if [ -d "$SEED_DIR" ]; then
    trash "$SEED_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM

if ! (
  cd "$ROOT_DIR"
  python3 scripts/build_catalog_seed.py --output-dir "$SEED_DIR" >/dev/null
); then
  echo "Catalog seed generation failed." >&2
  exit 1
fi

MANIFEST="$SEED_DIR/catalog-seed-manifest.json"
if [ ! -f "$MANIFEST" ]; then
  echo "Catalog seed manifest was not generated." >&2
  exit 1
fi

EXPECTED_VERSION=$(python3 - "$MANIFEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
version = manifest.get("data_version")
if not isinstance(version, str) or not version:
    raise SystemExit("invalid data_version")
print(version)
PY
)
EXPECTED_DIGEST=$(python3 - "$MANIFEST" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
digest = manifest.get("catalog_digest")
if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
    raise SystemExit("invalid catalog_digest")
print(digest)
PY
)
EXPECTED_ROW_COUNT=$(python3 - "$MANIFEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
count = manifest.get("row_count")
if isinstance(count, bool) or not isinstance(count, int) or count < 0:
    raise SystemExit("invalid row_count")
print(count)
PY
)

MANIFEST_FILES="$SEED_DIR/manifest-files.txt"
if ! python3 - "$MANIFEST" "$SEED_DIR" >"$MANIFEST_FILES" <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
output_dir = pathlib.Path(sys.argv[2]).resolve()
with manifest_path.open(encoding="utf-8") as handle:
    manifest = json.load(handle)

entries = manifest.get("files")
if not isinstance(entries, list) or not entries:
    raise SystemExit("invalid files manifest")
if entries[-1].get("name") != "catalog_metadata.sql":
    raise SystemExit("catalog metadata must be last")

seen = set()
seed_rows = 0
for index, entry in enumerate(entries):
    if not isinstance(entry, dict):
        raise SystemExit("invalid manifest entry")
    name = entry.get("name")
    digest = entry.get("sha256")
    rows = entry.get("rows")
    if (
        not isinstance(name, str)
        or not name
        or name in seen
        or "/" in name
        or "\\" in name
        or name in {".", ".."}
    ):
        raise SystemExit("invalid or duplicate seed filename")
    if not isinstance(digest, str) or len(digest) != 64:
        raise SystemExit("invalid seed digest")
    if isinstance(rows, bool) or not isinstance(rows, int) or rows < 0:
        raise SystemExit("invalid seed row count")
    path = output_dir / name
    if path.resolve().parent != output_dir or path.is_symlink() or not path.is_file():
        raise SystemExit("seed file is missing or outside the temporary directory")
    actual_digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual_digest != digest:
        raise SystemExit("seed file digest does not match its manifest")
    if index < len(entries) - 1:
        if not name.startswith("catalog_photos_") or rows == 0:
            raise SystemExit("invalid catalog photo chunk")
        seed_rows += rows
    elif rows != 1:
        raise SystemExit("invalid catalog metadata row count")
    seen.add(name)

if seed_rows != manifest.get("row_count"):
    raise SystemExit("manifest row count does not match its chunks")

for entry in entries:
    print(entry["name"])
PY
then
  echo "Catalog seed manifest validation failed." >&2
  exit 1
fi

CHUNK_COUNT=$(python3 - "$MANIFEST_FILES" <<'PY'
import pathlib
import sys

names = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
print(max(0, len(names) - 1))
PY
)
echo "Prepared catalog seed: ${EXPECTED_ROW_COUNT} rows in ${CHUNK_COUNT} chunks."

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run complete; no remote D1 command was run."
  exit 0
fi

WRANGLER_LOG="$SEED_DIR/wrangler.log"
PREFLIGHT_JSON="$SEED_DIR/preflight.json"
METADATA_QUERY="SELECT data_version, catalog_digest, row_count, (SELECT COUNT(*) FROM catalog_photos) AS actual_count FROM catalog_metadata WHERE singleton = 1;"
if ! run_wrangler d1 execute CORRECTIONS_DB \
  --remote \
  --command "$METADATA_QUERY" \
  --json >"$PREFLIGHT_JSON" 2>"$WRANGLER_LOG"; then
  echo "Remote catalog metadata query failed; no seed writes were attempted." >&2
  exit 1
fi

PREFLIGHT_STATE=$(python3 - "$PREFLIGHT_JSON" "$EXPECTED_VERSION" "$EXPECTED_ROW_COUNT" "$EXPECTED_DIGEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    raw = handle.read()
    # Wrangler emits a progress prelude even with --json for file imports.
    starts = [offset for offset in (raw.find("\n["), raw.find("\n{")) if offset >= 0]
    payload = json.loads(raw[min(starts) + 1:] if starts else raw)
responses = payload if isinstance(payload, list) else [payload]
if not responses or any(
    not isinstance(item, dict) or item.get("success") is False for item in responses
):
    print("INVALID")
    raise SystemExit(0)

rows = []
for response in responses:
    result = response.get("results")
    if isinstance(result, list):
        rows.extend(result)
if not rows:
    print("EMPTY")
    raise SystemExit(0)
if len(rows) != 1 or not isinstance(rows[0], dict):
    print("INVALID")
    raise SystemExit(0)

row = rows[0]
remote_version = row.get("data_version")
remote_digest = row.get("catalog_digest")
remote_count = row.get("row_count")
actual_count = row.get("actual_count")
if remote_version is None or remote_version == "":
    print("EMPTY")
elif (not isinstance(remote_version, str) or not isinstance(remote_digest, str)
      or isinstance(remote_count, bool) or not isinstance(remote_count, int)
      or isinstance(actual_count, bool) or not isinstance(actual_count, int)):
    print("INVALID")
elif remote_count == int(sys.argv[3]) and actual_count == int(sys.argv[3]):
    if remote_version == sys.argv[2] and remote_digest == sys.argv[4]:
        print("MATCH")
    elif remote_digest == sys.argv[4] or (remote_version == sys.argv[2] and not remote_digest):
        print("METADATA_ONLY")
    else:
        print("APPLY")
else:
    print("APPLY")
PY
)

case "$PREFLIGHT_STATE" in
  MATCH)
    echo "Remote catalog already matches the generated seed; nothing to do."
    exit 0
    ;;
  EMPTY|APPLY|METADATA_ONLY)
    ;;
  *)
    echo "Remote catalog metadata response was invalid; no seed writes were attempted." >&2
    exit 1
    ;;
esac

APPLY_FILES="$MANIFEST_FILES"
if [ "$PREFLIGHT_STATE" = METADATA_ONLY ]; then
  APPLY_FILES="$SEED_DIR/metadata-only.txt"
  printf '%s\n' 'catalog_metadata.sql' > "$APPLY_FILES"
  echo "Photo rows match; updating only the catalog version marker."
fi
TOTAL_FILES=$(wc -l <"$APPLY_FILES" | tr -d ' ')
chunk_response_succeeded() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    raw = handle.read()
    # Wrangler emits a progress prelude even with --json for file imports.
    starts = [offset for offset in (raw.find("\n["), raw.find("\n{")) if offset >= 0]
    try:
        payload = json.loads(raw[min(starts) + 1:] if starts else raw)
    except json.JSONDecodeError:
        raise SystemExit(1)
responses = payload if isinstance(payload, list) else [payload]
if not responses or any(
    not isinstance(item, dict) or item.get("success") is not True for item in responses
):
    raise SystemExit(1)
PY
}

INDEX=0
while IFS= read -r NAME; do
  INDEX=$((INDEX + 1))
  FILE_PATH="$SEED_DIR/$NAME"
  ATTEMPT=1
  while [ "$ATTEMPT" -le 3 ]; do
    if run_wrangler d1 execute CORRECTIONS_DB \
      --remote \
      --file "$FILE_PATH" \
      --yes \
      --json >"$SEED_DIR/last-command.json" 2>"$WRANGLER_LOG" &&
      chunk_response_succeeded "$SEED_DIR/last-command.json"; then
      break
    fi
    if [ "$ATTEMPT" -eq 3 ]; then
      echo "Remote catalog seed failed at file ${INDEX}/${TOTAL_FILES} after three idempotent attempts." >&2
      tail -n 12 "$WRANGLER_LOG" >&2
      exit 1
    fi
    sleep "$ATTEMPT"
    ATTEMPT=$((ATTEMPT + 1))
  done
  if [ $((INDEX % 20)) -eq 0 ]; then
    echo "Applied ${INDEX}/${TOTAL_FILES} catalog files."
  fi
done <"$APPLY_FILES"

VERIFY_JSON="$SEED_DIR/verify.json"
VERIFY_QUERY="SELECT data_version, catalog_digest, row_count, (SELECT COUNT(*) FROM catalog_photos) AS actual_count FROM catalog_metadata WHERE singleton = 1;"
if ! run_wrangler d1 execute CORRECTIONS_DB \
  --remote \
  --command "$VERIFY_QUERY" \
  --json >"$VERIFY_JSON" 2>"$WRANGLER_LOG"; then
  echo "Remote catalog verification query failed after seed writes." >&2
  exit 1
fi

if ! python3 - "$VERIFY_JSON" "$EXPECTED_VERSION" "$EXPECTED_ROW_COUNT" "$EXPECTED_DIGEST" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    raw = handle.read()
    # Wrangler emits a progress prelude even with --json for file imports.
    starts = [offset for offset in (raw.find("\n["), raw.find("\n{")) if offset >= 0]
    payload = json.loads(raw[min(starts) + 1:] if starts else raw)
responses = payload if isinstance(payload, list) else [payload]
if not responses or any(
    not isinstance(item, dict) or item.get("success") is False for item in responses
):
    raise SystemExit(1)
rows = []
for response in responses:
    result = response.get("results")
    if isinstance(result, list):
        rows.extend(result)
if len(rows) != 1 or not isinstance(rows[0], dict):
    raise SystemExit(1)
row = rows[0]
if (
    row.get("data_version") != sys.argv[2]
    or row.get("catalog_digest") != sys.argv[4]
    or row.get("row_count") != int(sys.argv[3])
    or row.get("actual_count") != int(sys.argv[3])
):
    raise SystemExit(1)
PY
then
  echo "Remote catalog verification failed; metadata or row count does not match the generated seed." >&2
  exit 1
fi

echo "Remote catalog seed applied and verified: ${EXPECTED_ROW_COUNT} rows."
