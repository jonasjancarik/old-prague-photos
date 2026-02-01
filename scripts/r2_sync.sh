#!/usr/bin/env bash
set -euo pipefail

SRC_DIR=${SRC_DIR:-"downloads/archive/zoomify"}
R2_BUCKET=${R2_BUCKET:-""}
R2_PREFIX=${R2_PREFIX:-"zoomify"}
R2_ACCOUNT_ID=${R2_ACCOUNT_ID:-""}
R2_ENDPOINT=${R2_ENDPOINT:-""}

usage() {
  cat <<USAGE
Usage: scripts/r2_sync.sh [--dry-run] [--delete] [--extra "<aws s3 sync args>"]

Env:
  SRC_DIR         Local zoomify root (default: downloads/archive/zoomify)
  R2_BUCKET       R2 bucket name (required)
  R2_PREFIX       Destination prefix (default: zoomify)
  R2_ACCOUNT_ID   Cloudflare account id (required unless R2_ENDPOINT set)
  R2_ENDPOINT     Override endpoint (e.g. https://<account>.r2.cloudflarestorage.com)
  R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)

Examples:
  R2_BUCKET=old-prague R2_ACCOUNT_ID=xxxx R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
    scripts/r2_sync.sh

  scripts/r2_sync.sh --dry-run
  scripts/r2_sync.sh --delete --extra "--size-only"
USAGE
}

DRY_RUN=""
DELETE_FLAG=""
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="--dryrun"
      shift
      ;;
    --delete)
      DELETE_FLAG="--delete"
      shift
      ;;
    --extra)
      EXTRA_ARGS=${2:-""}
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$R2_BUCKET" ]]; then
  echo "R2_BUCKET is required" >&2
  exit 1
fi

if [[ -z "$R2_ENDPOINT" ]]; then
  if [[ -z "$R2_ACCOUNT_ID" ]]; then
    echo "R2_ACCOUNT_ID or R2_ENDPOINT is required" >&2
    exit 1
  fi
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Source directory not found: $SRC_DIR" >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-${R2_ACCESS_KEY_ID:-""}}
export AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-${R2_SECRET_ACCESS_KEY:-""}}
export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-"auto"}

if [[ -z "$AWS_ACCESS_KEY_ID" || -z "$AWS_SECRET_ACCESS_KEY" ]]; then
  echo "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or R2_* equivalents) are required" >&2
  exit 1
fi

DEST="s3://${R2_BUCKET}/${R2_PREFIX}"

set -x
aws s3 sync "$SRC_DIR" "$DEST" \
  --endpoint-url "$R2_ENDPOINT" \
  ${DRY_RUN} \
  ${DELETE_FLAG} \
  ${EXTRA_ARGS}
