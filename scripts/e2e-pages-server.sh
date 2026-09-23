#!/bin/sh
set -eu

if [ -z "${PLAYWRIGHT_D1_STATE_DIR:-}" ]; then
  echo "PLAYWRIGHT_D1_STATE_DIR is required" >&2
  exit 2
fi

run_wrangler() {
  WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-/tmp/old-prague-e2e-wrangler.log}" \
    npm_config_ignore_scripts=true npx wrangler "$@"
}

CI=1 run_wrangler d1 migrations apply CORRECTIONS_DB \
  --local --persist-to "$PLAYWRIGHT_D1_STATE_DIR"

SEED_DIR="$PLAYWRIGHT_D1_STATE_DIR/catalog-seed"
python3 scripts/build_catalog_seed.py --output-dir "$SEED_DIR" >/dev/null
cat "$SEED_DIR"/catalog_photos_*.sql "$SEED_DIR"/catalog_metadata.sql \
  > "$SEED_DIR/catalog.sql"
CI=1 run_wrangler d1 execute CORRECTIONS_DB \
  --local --persist-to "$PLAYWRIGHT_D1_STATE_DIR" \
  --file "$SEED_DIR/catalog.sql" --yes

run_wrangler pages dev viewer/static \
  --local \
  --ip 0.0.0.0 \
  --port "${PLAYWRIGHT_PORT:-8790}" \
  --persist-to "$PLAYWRIGHT_D1_STATE_DIR" \
  --binding "TURNSTILE_BYPASS=1" \
  --binding "MAPY_CZ_API_KEY=e2e-host-restricted-test-key"
