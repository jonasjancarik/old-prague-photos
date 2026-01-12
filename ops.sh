#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"

usage() {
  cat <<'EOF'
ops.sh — běžné kroky (lokálně + Cloudflare)

Použití:
  ./ops.sh build-data           # export CSV + build GeoJSON
  ./ops.sh build-similarity     # candidate páry podobných záběrů
  ./ops.sh dev-fastapi [port]   # lokální server (FastAPI)
                               # default: scan od 8000 na první volný port
  ./ops.sh dev-pages            # lokální Pages (Functions + D1 local)
  ./ops.sh migrate-local        # D1 migrace (local persist)
  ./ops.sh migrate-remote       # D1 migrace (remote)
  ./ops.sh deploy               # deploy na Cloudflare Pages

Env:
  TURNSTILE_BYPASS=1            # vypne Turnstile (lokálně)
  PROJECT_NAME=...              # Pages project (pro deploy)
EOF
}

find_free_port() {
  local start="${1:-8000}"
  python - "$start" <<'PY'
import socket
import sys

start = int(sys.argv[1])
for port in range(start, start + 1000):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            continue
        print(port)
        sys.exit(0)
sys.exit(1)
PY
}

case "$cmd" in
  build-data)
    uv run cli export
    python viewer/build_geojson.py
    ;;
  build-similarity)
    python build_similarity.py
    ;;
  dev-fastapi)
    port_arg="${2:-}"
    if [[ -z "$port_arg" || "$port_arg" == "scan" ]]; then
      port="$(find_free_port 8000)"
    elif [[ "$port_arg" =~ ^[0-9]+$ ]]; then
      port="$port_arg"
    else
      echo "Invalid port: $port_arg" >&2
      exit 2
    fi
    uv run uvicorn viewer.app:app --reload \
      --port "$port" \
      --reload-dir viewer \
      --reload-dir viewer/static \
      --reload-include "*.html" \
      --reload-include "*.css" \
      --reload-include "*.js" \
      --reload-include "*.geojson"
    ;;
  dev-pages)
    TURNSTILE_BYPASS="${TURNSTILE_BYPASS:-1}" npx wrangler pages dev viewer/static --local
    ;;
  migrate-local)
    npx wrangler d1 migrations apply CORRECTIONS_DB --local --persist-to .wrangler/state
    ;;
  migrate-remote)
    npx wrangler d1 migrations apply CORRECTIONS_DB --remote
    ;;
  deploy)
    project="${PROJECT_NAME:-}"
    if [[ -z "$project" ]]; then
      echo "Missing PROJECT_NAME. Example: PROJECT_NAME=old-prague-photos-viewer ./ops.sh deploy" >&2
      exit 2
    fi
    npx wrangler pages deploy viewer/static --project-name "$project"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 2
    ;;
esac
