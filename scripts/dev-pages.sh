#!/bin/sh
set -eu

if [ ! -x viewer/react/node_modules/.bin/vite ]; then
  echo "Installing frontend dependencies..."
  npm --prefix viewer/react ci
fi

run_wrangler() {
  # Avoid optional native install scripts during ephemeral npx resolution.
  npm_config_ignore_scripts=true npx --yes wrangler "$@"
}

npm run prepare:community-data
echo "Applying local D1 migrations..."
CI=1 run_wrangler d1 migrations apply CORRECTIONS_DB --local

SEED_DIR=$(mktemp -d "${TMPDIR:-/tmp}/old-prague-pages-dev-seed.XXXXXX")
cleanup_seed() {
  trash "$SEED_DIR" 2>/dev/null || true
}
trap cleanup_seed EXIT INT TERM
python3 scripts/build_catalog_seed.py --output-dir "$SEED_DIR" >/dev/null
cat "$SEED_DIR"/catalog_photos_*.sql "$SEED_DIR"/catalog_metadata.sql \
  > "$SEED_DIR/catalog.sql"
CI=1 run_wrangler d1 execute CORRECTIONS_DB --local \
  --file "$SEED_DIR/catalog.sql" --yes

npm --prefix viewer/react run dev &
FRONTEND_WATCH_PID=$!

cleanup() {
  kill "$FRONTEND_WATCH_PID" 2>/dev/null || true
  wait "$FRONTEND_WATCH_PID" 2>/dev/null || true
  cleanup_seed
}

trap cleanup EXIT INT TERM

echo "Cloudflare Pages dev server will print its local URL below."
echo "Frontend build watcher is running in the background."

run_wrangler pages dev viewer/static --local \
  --ip 0.0.0.0 \
  --binding "TURNSTILE_BYPASS=${TURNSTILE_BYPASS:-1}"
