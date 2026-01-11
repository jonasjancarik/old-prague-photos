#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"

usage() {
  cat <<'EOF'
ops.sh — běžné kroky (lokálně + Cloudflare)

Použití:
  ./ops.sh build-data           # export CSV + build GeoJSON
  ./ops.sh dev-fastapi          # lokální server (FastAPI)
  ./ops.sh dev-pages            # lokální Pages (Functions + D1 local)
  ./ops.sh migrate-local        # D1 migrace (local persist)
  ./ops.sh migrate-remote       # D1 migrace (remote)
  ./ops.sh deploy               # deploy na Cloudflare Pages

Env:
  TURNSTILE_BYPASS=1            # vypne Turnstile (lokálně)
  PROJECT_NAME=...              # Pages project (pro deploy)
EOF
}

case "$cmd" in
  build-data)
    uv run cli export
    python viewer/build_geojson.py
    ;;
  dev-fastapi)
    uv run uvicorn viewer.app:app --reload \
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
