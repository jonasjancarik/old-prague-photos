#!/bin/sh
set -eu

PROJECT_NAME="${PAGES_PROJECT_NAME:-old-prague-photos-viewer}"
BRANCH="${PAGES_STAGING_BRANCH:-staging}"
STAGING_URL="${PAGES_STAGING_URL:-https://${BRANCH}.${PROJECT_NAME}.pages.dev}"
SENTINEL_ID="00000000-0000-0000-0000-000000000000"

case "$BRANCH" in
  main|master|production)
    echo "Refusing to use production-like branch '$BRANCH' for staging." >&2
    exit 2
    ;;
esac

if grep -q "database_id = \"$SENTINEL_ID\"" wrangler.toml; then
  echo "Staging D1 is not configured." >&2
  echo "Create old-prague-photos-staging and replace the fail-closed UUID in wrangler.toml." >&2
  exit 2
fi

PRODUCTION_ID="$(awk '
  /^\[\[d1_databases\]\]/ { in_production = 1; next }
  /^\[\[/ { in_production = 0 }
  in_production && /database_id/ { gsub(/[\"[:space:]]/, "", $3); print $3; exit }
' wrangler.toml)"
STAGING_ID="$(awk '
  /^\[\[env\.preview\.d1_databases\]\]/ { in_preview = 1; next }
  /^\[\[/ { in_preview = 0 }
  in_preview && /database_id/ { gsub(/[\"[:space:]]/, "", $3); print $3; exit }
' wrangler.toml)"

if [ -z "$STAGING_ID" ] || [ "$STAGING_ID" = "$PRODUCTION_ID" ]; then
  echo "Staging D1 must have a nonempty UUID distinct from production." >&2
  exit 2
fi

npm run prepare:community-data
npm run release:verify

# The preview environment supplies a separate D1 binding. Migrate and deploy
# that environment together, then verify the stable staging hostname.
CI=1 npx wrangler d1 migrations apply CORRECTIONS_DB --remote --env preview
npx wrangler pages deploy viewer/static --project-name "$PROJECT_NAME" --branch "$BRANCH"
SMOKE_REQUIRE_SECURE_CONFIG=1 SMOKE_REQUIRE_ACCESS=1 \
  npm run smoke:pages -- "$STAGING_URL"
