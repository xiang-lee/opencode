#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/clawd/clawd/projects/opencode}"
SERVER_ENV="${SERVER_ENV:-/home/clawd/.config/opencode/server.env}"
SERVER_URL="${SERVER_URL:-http://127.0.0.1:4096}"
SERVER_FILE="${SERVER_FILE:-$REPO_DIR/packages/opencode/src/server/server.ts}"

if [[ ! -d "$REPO_DIR" ]]; then
  echo "error: repo dir not found: $REPO_DIR" >&2
  exit 1
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

if [[ ! -f "$SERVER_FILE" ]]; then
  echo "error: server file not found: $SERVER_FILE" >&2
  exit 1
fi

if ! grep -q "serveLocalWebAsset" "$SERVER_FILE"; then
  echo "error: local web asset logic missing from $SERVER_FILE" >&2
  exit 1
fi

html="$(curl -fsS -u "$USERNAME:$PASSWORD" "$SERVER_URL/")"
js_asset="$(printf '%s' "$html" | grep -oE '/assets/index-[^" ]+\.js' | head -n1 || true)"
css_asset="$(printf '%s' "$html" | grep -oE '/assets/index-[^" ]+\.css' | head -n1 || true)"

if [[ -z "$js_asset" ]]; then
  echo "error: could not find JS asset reference in server HTML" >&2
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

echo "OK: Web UI is serving the local fork build"
echo "HTML JS asset:  $js_asset"
echo "Local JS file: $js_file"
if [[ -n "$css_asset" ]]; then
  echo "HTML CSS asset: $css_asset"
fi
