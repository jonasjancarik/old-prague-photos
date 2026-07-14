#!/bin/sh
set -eu

TARGET="${1:-}"
case "$TARGET" in
  production)
    WRANGLER_ENV_ARGS=""
    ;;
  preview)
    WRANGLER_ENV_ARGS="--env preview"
    ;;
  *)
    echo "Usage: $0 production|preview" >&2
    exit 2
    ;;
esac

if [ -z "${D1_BACKUP_DIR:-}" ]; then
  echo "Set D1_BACKUP_DIR to a retained, access-controlled directory." >&2
  exit 2
fi

umask 077
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CHECKPOINT_DIR="$D1_BACKUP_DIR/$TARGET/$STAMP"
mkdir -p "$CHECKPOINT_DIR"

# shellcheck disable=SC2086
npx wrangler d1 time-travel info CORRECTIONS_DB $WRANGLER_ENV_ARGS --json \
  > "$CHECKPOINT_DIR/time-travel.json"
# shellcheck disable=SC2086
npx wrangler d1 export CORRECTIONS_DB --remote $WRANGLER_ENV_ARGS \
  --output "$CHECKPOINT_DIR/database.sql" --skip-confirmation

git rev-parse HEAD > "$CHECKPOINT_DIR/git-commit.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$CHECKPOINT_DIR/created-at.txt"

echo "D1 checkpoint written to $CHECKPOINT_DIR"
