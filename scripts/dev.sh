#!/bin/sh
set -eu

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
START_PORT="$PORT"

PORT="$(python3 - "$HOST" "$PORT" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
max_port = 65535

def can_connect(address_family, connect_host, candidate_port):
    with socket.socket(address_family, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((connect_host, candidate_port)) == 0

def can_bind(address_family, bind_host, candidate_port):
    with socket.socket(address_family, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((bind_host, candidate_port))
        except OSError:
            return False
    return True

def is_loopback_host(value):
    return value in {"127.0.0.1", "localhost", "::1"}

bind_family = socket.AF_INET6 if ":" in host else socket.AF_INET
bind_host = "127.0.0.1" if host == "localhost" else host

while port <= max_port:
    if is_loopback_host(host) and can_connect(socket.AF_INET, "127.0.0.1", port):
        port += 1
        continue
    if is_loopback_host(host) and socket.has_ipv6 and can_connect(socket.AF_INET6, "::1", port):
        port += 1
        continue
    if not can_bind(bind_family, bind_host, port):
        port += 1
        continue
    if host in {"127.0.0.1", "localhost"} and socket.has_ipv6 and not can_bind(socket.AF_INET6, "::1", port):
        port += 1
        continue
    print(port)
    sys.exit(0)

print(f"No available port found at or above {sys.argv[2]}", file=sys.stderr)
sys.exit(1)
PY
)"

if [ "$PORT" != "$START_PORT" ]; then
  echo "Port ${HOST}:${START_PORT} is already in use. Using ${HOST}:${PORT} instead."
fi

if [ "$HOST" = "::1" ]; then
  DEV_URL="http://[${HOST}]:${PORT}"
  ALT_DEV_URL=""
elif [ "$HOST" = "127.0.0.1" ]; then
  DEV_URL="http://localhost:${PORT}"
  ALT_DEV_URL="http://${HOST}:${PORT}"
else
  DEV_URL="http://${HOST}:${PORT}"
  ALT_DEV_URL=""
fi

print_dev_url() {
  echo
  echo "============================================================"
  echo "  Local dev server"
  echo "  ${DEV_URL}"
  if [ -n "$ALT_DEV_URL" ]; then
    echo "  also: ${ALT_DEV_URL}"
  fi
  echo "============================================================"
  echo
}

print_dev_url

if [ ! -x viewer/react/node_modules/.bin/vite ]; then
  echo "Installing frontend dependencies..."
  npm --prefix viewer/react ci
fi

npm --prefix viewer/react run dev &
FRONTEND_WATCH_PID=$!
(
  sleep "${DEV_URL_REPEAT_DELAY:-5}"
  print_dev_url
) &
DEV_URL_NOTICE_PID=$!

cleanup() {
  kill "$DEV_URL_NOTICE_PID" 2>/dev/null || true
  wait "$DEV_URL_NOTICE_PID" 2>/dev/null || true
  kill "$FRONTEND_WATCH_PID" 2>/dev/null || true
  wait "$FRONTEND_WATCH_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

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
