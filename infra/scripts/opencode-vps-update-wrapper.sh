#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/clawd/clawd/projects/opencode"
RUN_AS="clawd"
REMOTE="origin"
BRANCH="dev"
SERVICE_NAME="opencode.service"
SERVER_ENV="/home/clawd/.config/opencode/server.env"
SERVER_URL="http://127.0.0.1:4096"
SERVER_FILE="$REPO_DIR/packages/opencode/src/server/server.ts"
SKIP_PULL=0

usage() {
  cat <<USAGE
Usage: sudo /usr/local/sbin/opencode-vps-update [--skip-pull]

Updates the VPS checkout from origin/dev, restarts opencode.service, and verifies that the Web UI is served from the local fork build.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull)
      SKIP_PULL=1
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

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "error: must run as root" >&2
  exit 1
fi

run_as_user() {
  sudo -u "$RUN_AS" bash -lc "$1"
}

validate_local_web() {
  if [[ ! -f "$SERVER_ENV" ]]; then
    echo "error: server env not found: $SERVER_ENV" >&2
    return 1
  fi

  # shellcheck disable=SC1090
  source "$SERVER_ENV"
  local username password html js_asset css_asset js_file css_file
  username="${OPENCODE_SERVER_USERNAME:-opencode}"
  password="${OPENCODE_SERVER_PASSWORD:-}"

  if [[ -z "$password" ]]; then
    echo "error: OPENCODE_SERVER_PASSWORD is empty in $SERVER_ENV" >&2
    return 1
  fi

  if [[ ! -f "$SERVER_FILE" ]]; then
    echo "error: server file not found: $SERVER_FILE" >&2
    return 1
  fi

  if ! grep -q "serveLocalWebAsset" "$SERVER_FILE"; then
    echo "error: local web asset logic missing from $SERVER_FILE" >&2
    return 1
  fi

  html="$(curl -fsS -u "$username:$password" "$SERVER_URL/")"
  js_asset="$(printf '%s' "$html" | grep -oE '/assets/index-[^" ]+\.js' | head -n1 || true)"
  css_asset="$(printf '%s' "$html" | grep -oE '/assets/index-[^" ]+\.css' | head -n1 || true)"

  if [[ -z "$js_asset" ]]; then
    echo "error: could not find JS asset reference in server HTML" >&2
    return 1
  fi

  js_file="$REPO_DIR/packages/app/dist${js_asset}"
  if [[ ! -f "$js_file" ]]; then
    echo "error: HTML points to $js_asset but local file is missing" >&2
    find "$REPO_DIR/packages/app/dist/assets" -maxdepth 1 -type f -name 'index-*' | sort >&2 || true
    return 1
  fi

  if [[ -n "$css_asset" ]]; then
    css_file="$REPO_DIR/packages/app/dist${css_asset}"
    if [[ ! -f "$css_file" ]]; then
      echo "error: HTML points to $css_asset but local file is missing" >&2
      return 1
    fi
  fi

  echo "OK: Web UI is serving the local fork build"
  echo "HTML JS asset:  $js_asset"
  echo "Local JS file: $js_file"
  if [[ -n "$css_asset" ]]; then
    echo "HTML CSS asset: $css_asset"
  fi
}

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "error: git repo not found: $REPO_DIR" >&2
  exit 1
fi

status_output="$(run_as_user "cd '$REPO_DIR' && git status --porcelain")"
if [[ -n "$status_output" ]]; then
  echo "error: repo is dirty; refusing to update" >&2
  printf '%s\n' "$status_output" >&2
  exit 1
fi

if [[ $SKIP_PULL -eq 0 ]]; then
  run_as_user "cd '$REPO_DIR' && git fetch '$REMOTE' '$BRANCH' && git pull --ff-only '$REMOTE' '$BRANCH'"
fi

if [[ -d "$REPO_DIR/packages/app/dist" ]]; then
  chown -R "$RUN_AS:$RUN_AS" "$REPO_DIR/packages/app/dist"
fi

systemctl daemon-reload
systemctl restart "$SERVICE_NAME"

for _ in $(seq 1 120); do
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    break
  fi
  state="$(systemctl show -p ActiveState --value "$SERVICE_NAME" 2>/dev/null || true)"
  if [[ "$state" == "failed" ]]; then
    echo "error: $SERVICE_NAME failed to start" >&2
    systemctl --no-pager --lines=80 status "$SERVICE_NAME" >&2 || true
    exit 1
  fi
  sleep 1
done

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "error: timed out waiting for $SERVICE_NAME" >&2
  systemctl --no-pager --lines=80 status "$SERVICE_NAME" >&2 || true
  exit 1
fi

ready=0
for _ in $(seq 1 30); do
  if validate_local_web >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ $ready -ne 1 ]]; then
  echo "error: service started but Web UI validation did not pass in time" >&2
  validate_local_web
  exit 1
fi

validate_local_web
run_as_user "cd '$REPO_DIR' && printf 'Current commit: '; git rev-parse --short HEAD"
