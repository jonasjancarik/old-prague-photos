#!/bin/sh
set -eu

PROJECT_NAME="${PAGES_PROJECT_NAME:-old-prague-photos-viewer}"
PRODUCTION_BRANCH="${PAGES_PRODUCTION_BRANCH:-main}"
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

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [ "$CURRENT_BRANCH" != "$PRODUCTION_BRANCH" ]; then
  echo "Production deployment must run from branch '$PRODUCTION_BRANCH' (current: '${CURRENT_BRANCH:-detached HEAD}')." >&2
  exit 2
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Production deployment must run from a clean reviewed commit." >&2
  exit 2
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "Set CLOUDFLARE_ACCOUNT_ID to verify the Pages production branch." >&2
  exit 2
fi

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  PROJECT_CONFIG="$(
    curl --fail --silent --show-error \
      --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT_NAME"
  )"
  REMOTE_PRODUCTION_BRANCH="$(printf '%s' "$PROJECT_CONFIG" | jq -r '.result.production_branch // empty')"
else
  if ! command -v cf >/dev/null 2>&1; then
    echo "Install the Cloudflare cf CLI or set CLOUDFLARE_API_TOKEN to verify the Pages production branch." >&2
    exit 2
  fi
  PROJECT_CONFIG="$(cf pages projects get "$PROJECT_NAME")"
  REMOTE_PRODUCTION_BRANCH="$(printf '%s' "$PROJECT_CONFIG" | jq -r '.production_branch // empty')"
fi
if [ -z "$REMOTE_PRODUCTION_BRANCH" ]; then
  echo "Could not determine the Pages production branch for '$PROJECT_NAME'." >&2
  exit 2
fi
if [ "$REMOTE_PRODUCTION_BRANCH" != "$PRODUCTION_BRANCH" ]; then
  echo "Pages production branch is '$REMOTE_PRODUCTION_BRANCH', not '$PRODUCTION_BRANCH'." >&2
  exit 2
fi

# This creates an asset-bound version manifest consumed by Pages Functions.
# It invalidates projections atomically with every deployed data bundle.
npm run prepare:community-data
npm run release:verify
if [ -n "$(git status --porcelain)" ]; then
  echo "The release gate changed tracked files; review and commit them before deployment." >&2
  exit 2
fi

# Capture both a portable SQL export and a Time Travel bookmark before any
# remote schema mutation. The checkpoint contains private contribution data.
scripts/checkpoint-d1.sh production

# Migrations are additive/backward-compatible and must land before Functions
# start querying the new projection tables.
CI=1 npx wrangler d1 migrations apply CORRECTIONS_DB --remote
scripts/seed-catalog-d1.sh
npx wrangler pages deploy viewer/static \
  --project-name "$PROJECT_NAME" \
  --branch "$PRODUCTION_BRANCH"
SMOKE_REQUIRE_SECURE_CONFIG=1 SMOKE_REQUIRE_ACCESS=1 \
  npm run smoke:pages -- "$PAGES_PRODUCTION_URL"
