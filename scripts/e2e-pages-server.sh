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

run_wrangler pages dev viewer/static \
  --local \
  --ip 127.0.0.1 \
  --port "${PLAYWRIGHT_PORT:-8790}" \
  --persist-to "$PLAYWRIGHT_D1_STATE_DIR" \
  --binding "TURNSTILE_BYPASS=1" \
  --binding "MAPY_CZ_API_KEY=e2e-host-restricted-test-key"
