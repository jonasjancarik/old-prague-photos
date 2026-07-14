#!/bin/sh
set -eu

TARGET="${1:-}"
case "$TARGET" in
  production)
    WRANGLER_ENV_ARGS=""
    EXPECTED_CONFIRMATION="restore-old-prague-photos-production"
    ;;
  preview)
    WRANGLER_ENV_ARGS="--env preview"
    EXPECTED_CONFIRMATION="restore-old-prague-photos-preview"
    ;;
  *)
    echo "Usage: $0 production|preview" >&2
    exit 2
    ;;
esac

if [ -z "${D1_RESTORE_BOOKMARK:-}" ] && [ -z "${D1_RESTORE_TIMESTAMP:-}" ]; then
  echo "Set exactly one of D1_RESTORE_BOOKMARK or D1_RESTORE_TIMESTAMP." >&2
  exit 2
fi

if [ -n "${D1_RESTORE_BOOKMARK:-}" ] && [ -n "${D1_RESTORE_TIMESTAMP:-}" ]; then
  echo "Set only one of D1_RESTORE_BOOKMARK or D1_RESTORE_TIMESTAMP." >&2
  exit 2
fi

if [ "${CONFIRM_D1_RESTORE:-}" != "$EXPECTED_CONFIRMATION" ]; then
  echo "D1 restore is destructive and disabled by default." >&2
  echo "Set CONFIRM_D1_RESTORE=$EXPECTED_CONFIRMATION after reviewing the checkpoint." >&2
  exit 2
fi

if [ -n "${D1_RESTORE_BOOKMARK:-}" ]; then
  # shellcheck disable=SC2086
  CI=1 npx wrangler d1 time-travel restore CORRECTIONS_DB $WRANGLER_ENV_ARGS \
    --bookmark "$D1_RESTORE_BOOKMARK" --json
else
  # shellcheck disable=SC2086
  CI=1 npx wrangler d1 time-travel restore CORRECTIONS_DB $WRANGLER_ENV_ARGS \
    --timestamp "$D1_RESTORE_TIMESTAMP" --json
fi
