#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/clawd/clawd/projects/opencode}"
SERVER_ENV="${SERVER_ENV:-/home/clawd/.config/opencode/server.env}"
SERVER_URL="${SERVER_URL:-http://127.0.0.1:4096}"
SOURCE_ONLY=0

usage() {
  cat <<USAGE
Usage: ./infra/scripts/check-vps-web-build.sh [--source-only]

Verifies that the VPS source still contains the Mac Web UI fixes and, unless --source-only is used, that the running server is serving the local fork build.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-only)
      SOURCE_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

SERVER_FILE="$REPO_DIR/packages/opencode/src/server/server.ts"
SYNC_FILE="$REPO_DIR/packages/app/src/context/sync.tsx"
SESSION_FILE="$REPO_DIR/packages/app/src/pages/session.tsx"
TURN_FILE="$REPO_DIR/packages/ui/src/components/session-turn.tsx"

for file in "$SERVER_FILE" "$SYNC_FILE" "$SESSION_FILE" "$TURN_FILE"; do
  if [[ ! -f "$file" ]]; then
    echo "error: required file not found: $file" >&2
    exit 1
  fi
done

require_grep() {
  local pattern="$1"
  local file="$2"
  local message="$3"
  if ! grep -Fq "$pattern" "$file"; then
    echo "error: $message" >&2
    echo "missing pattern: $pattern" >&2
    echo "file: $file" >&2
    exit 1
  fi
}

require_grep 'serveLocalWebAsset' "$SERVER_FILE" 'local web asset serving logic is missing from server.ts'
require_grep 'const refresh = options?.refresh === true' "$SYNC_FILE" 'refresh-aware session sync is missing from sync.tsx'
require_grep 'hasMessages && hydrated && !refresh' "$SYNC_FILE" 'refresh bypass logic is missing from sync.tsx'
require_grep 'window.setInterval(() => {' "$SESSION_FILE" 'periodic Mac Web resync timer is missing from session.tsx'
require_grep 'document.visibilityState !== "visible"' "$SESSION_FILE" 'visibility guard is missing from session.tsx'
require_grep 'sync.session.sync(id, { refresh: true })' "$SESSION_FILE" 'forced refresh resync is missing from session.tsx'
require_grep 'function compareMessages' "$TURN_FILE" 'message time sorting helper is missing from session-turn.tsx'
require_grep 'time?.created ?? 0' "$TURN_FILE" 'message time-based sorting is missing from session-turn.tsx'

echo 'OK: critical Mac Web UI source fixes are present'

if [[ $SOURCE_ONLY -eq 1 ]]; then
  exit 0
fi

if [[ ! -f "$SERVER_ENV" ]]; then
  echo "error: server env not found: $SERVER_ENV" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$SERVER_ENV"
USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"

if [[ -z "$PASSWORD" ]]; then
  echo "error: OPENCODE_SERVER_PASSWORD is empty in $SERVER_ENV" >&2
  exit 1
fi

html="$(curl -fsS -u "$USERNAME:$PASSWORD" "$SERVER_URL/")"
js_asset="$(printf '%s' "$html" | grep -oE '/assets/index-[^" ]+\.js' | head -n1 || true)"
css_asset="$(printf '%s' "$html" | grep -oE '/assets/index-[^" ]+\.css' | head -n1 || true)"

if [[ -z "$js_asset" ]]; then
  echo 'error: could not find JS asset reference in server HTML' >&2
  exit 1
fi

js_file="$REPO_DIR/packages/app/dist${js_asset}"
if [[ ! -f "$js_file" ]]; then
  echo "error: HTML points to $js_asset but local file is missing" >&2
  find "$REPO_DIR/packages/app/dist/assets" -maxdepth 1 -type f -name 'index-*' | sort >&2 || true
  exit 1
fi

if [[ -n "$css_asset" ]]; then
  css_file="$REPO_DIR/packages/app/dist${css_asset}"
  if [[ ! -f "$css_file" ]]; then
    echo "error: HTML points to $css_asset but local file is missing" >&2
    exit 1
  fi
fi

echo 'OK: Web UI is serving the local fork build'
echo "HTML JS asset:  $js_asset"
echo "Local JS file: $js_file"
if [[ -n "$css_asset" ]]; then
  echo "HTML CSS asset: $css_asset"
fi
