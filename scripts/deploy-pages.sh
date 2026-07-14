#!/bin/sh
set -eu

PROJECT_NAME="${PAGES_PROJECT_NAME:-old-prague-photos-viewer}"
EXPECTED_CONFIRMATION="old-prague-photos"

if [ "${CONFIRM_PRODUCTION_DEPLOY:-}" != "$EXPECTED_CONFIRMATION" ]; then
  echo "Production deployment is disabled by default." >&2
  echo "Set CONFIRM_PRODUCTION_DEPLOY=$EXPECTED_CONFIRMATION after reviewing the release." >&2
  exit 2
fi

if [ -z "${D1_BACKUP_DIR:-}" ]; then
  echo "Set D1_BACKUP_DIR to a retained, access-controlled backup directory." >&2
  exit 2
fi

if [ -z "${PAGES_PRODUCTION_URL:-}" ]; then
  echo "Set PAGES_PRODUCTION_URL to the public production origin for post-deploy smoke checks." >&2
  exit 2
fi

# This creates an asset-bound version manifest consumed by Pages Functions.
# It invalidates projections atomically with every deployed data bundle.
npm run prepare:community-data
npm run release:verify

# Capture both a portable SQL export and a Time Travel bookmark before any
# remote schema mutation. The checkpoint contains private contribution data.
scripts/checkpoint-d1.sh production

# Migrations are additive/backward-compatible and must land before Functions
# start querying the new projection tables.
CI=1 npx wrangler d1 migrations apply CORRECTIONS_DB --remote
npx wrangler pages deploy viewer/static --project-name "$PROJECT_NAME"
SMOKE_REQUIRE_SECURE_CONFIG=1 SMOKE_REQUIRE_ACCESS=1 \
  npm run smoke:pages -- "$PAGES_PRODUCTION_URL"
