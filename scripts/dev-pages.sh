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

echo "Applying local D1 migrations..."
CI=1 run_wrangler d1 migrations apply CORRECTIONS_DB --local

npm --prefix viewer/react run dev &
FRONTEND_WATCH_PID=$!

cleanup() {
  kill "$FRONTEND_WATCH_PID" 2>/dev/null || true
  wait "$FRONTEND_WATCH_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "Cloudflare Pages dev server will print its local URL below."
echo "Frontend build watcher is running in the background."

TURNSTILE_BYPASS="${TURNSTILE_BYPASS:-1}" run_wrangler pages dev viewer/static --local
