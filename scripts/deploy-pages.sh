#!/bin/sh
set -eu

PROJECT_NAME="${PAGES_PROJECT_NAME:-old-prague-photos-viewer}"

# This creates an asset-bound version manifest consumed by Pages Functions.
# It invalidates projections atomically with every deployed data bundle.
npm run prepare:community-data
npm test
npm run build:viewer

# Migrations are additive/backward-compatible and must land before Functions
# start querying the new projection tables.
CI=1 npx wrangler d1 migrations apply CORRECTIONS_DB --remote
npx wrangler pages deploy viewer/static --project-name "$PROJECT_NAME"
