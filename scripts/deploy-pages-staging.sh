#!/bin/sh
set -eu

PROJECT_NAME="${PAGES_PROJECT_NAME:-old-prague-photos-viewer}"
BRANCH="${PAGES_STAGING_BRANCH:-staging}"
SENTINEL_ID="00000000-0000-0000-0000-000000000000"
EXPECTED_CONFIRMATION="old-prague-photos-staging"

if [ "${CONFIRM_STAGING_DEPLOY:-}" != "$EXPECTED_CONFIRMATION" ]; then
  echo "Staging deployment is disabled by default." >&2
  echo "Set CONFIRM_STAGING_DEPLOY=$EXPECTED_CONFIRMATION after reviewing the release." >&2
  exit 2
fi

if [ -z "${D1_BACKUP_DIR:-}" ]; then
  echo "Set D1_BACKUP_DIR to a retained, access-controlled backup directory." >&2
  exit 2
fi

if [ -z "${PAGES_STAGING_URL:-}" ]; then
  echo "Set PAGES_STAGING_URL to the protected staging origin for post-deploy smoke checks." >&2
  exit 2
fi

if [ -z "${ADMIN_API_TOKEN:-}" ]; then
  echo "Set ADMIN_API_TOKEN for the protected staging smoke checks." >&2
  exit 2
fi
if [ -z "${CF_ACCESS_CLIENT_ID:-}" ]; then
  echo "Set CF_ACCESS_CLIENT_ID for the protected staging smoke checks." >&2
  exit 2
fi
if [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  echo "Set CF_ACCESS_CLIENT_SECRET for the protected staging smoke checks." >&2
  exit 2
fi

if ! WORKTREE_STATUS="$(git status --porcelain)"; then
  echo "Could not verify that the staging worktree is clean." >&2
  exit 2
fi
if [ -n "$WORKTREE_STATUS" ]; then
  echo "Staging deployment must run from a clean worktree." >&2
  exit 2
fi

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
# that environment together, then verify the stable staging hostname. Capture
# both a portable export and Time Travel bookmark before any schema mutation.
scripts/checkpoint-d1.sh preview
CI=1 npx wrangler d1 migrations apply CORRECTIONS_DB --remote --env preview
npx wrangler pages deploy viewer/static --project-name "$PROJECT_NAME" --branch "$BRANCH"
SMOKE_REQUIRE_SECURE_CONFIG=1 SMOKE_REQUIRE_ACCESS=1 \
  npm run smoke:pages -- "$PAGES_STAGING_URL"
