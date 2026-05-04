#!/bin/sh
set -eu

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

if [ ! -x viewer/react/node_modules/.bin/vite ]; then
  echo "Installing frontend dependencies..."
  npm --prefix viewer/react ci
fi

npm --prefix viewer/react run dev &
FRONTEND_WATCH_PID=$!

cleanup() {
  kill "$FRONTEND_WATCH_PID" 2>/dev/null || true
  wait "$FRONTEND_WATCH_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "Local dev server: http://${HOST}:${PORT}"
echo "Frontend build watcher is running in the background."

TURNSTILE_BYPASS="${TURNSTILE_BYPASS:-1}" uv run uvicorn viewer.app:app --reload \
  --host "$HOST" \
  --port "$PORT" \
  --reload-dir viewer \
  --reload-dir viewer/static \
  --reload-include "*.html" \
  --reload-include "*.css" \
  --reload-include "*.js" \
  --reload-include "*.geojson"
