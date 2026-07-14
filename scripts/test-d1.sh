#!/bin/sh
set -eu

STATE_DIR="${TMPDIR:-/tmp}/old-prague-d1-test-$$"

CI=1 npx wrangler d1 migrations apply CORRECTIONS_DB \
  --local \
  --persist-to "$STATE_DIR"

CI=1 npx wrangler d1 execute CORRECTIONS_DB \
  --local \
  --persist-to "$STATE_DIR" \
  --file scripts/d1-smoke.sql
