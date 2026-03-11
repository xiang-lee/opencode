#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/clawd/clawd/projects/opencode}"
RUN_AS="${RUN_AS:-clawd}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-dev}"
SERVICE_NAME="${SERVICE_NAME:-opencode.service}"
CHECK_SCRIPT_REL="infra/scripts/check-vps-web-build.sh"
SKIP_PULL=0
ARGS=("$@")

usage() {
  cat <<USAGE
Usage: sudo ./infra/scripts/update-vps-opencode.sh [--branch <name>] [--remote <name>] [--skip-pull]

Updates the VPS checkout, restarts ${SERVICE_NAME}, and verifies that the Web UI is served from the local fork build.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --remote)
      REMOTE="$2"
      shift 2
      ;;
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
  exec sudo "$0" "${ARGS[@]}"
fi

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "error: git repo not found: $REPO_DIR" >&2
  exit 1
fi

run_as_user() {
  sudo -u "$RUN_AS" bash -lc "$1"
}

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

"$REPO_DIR/$CHECK_SCRIPT_REL"
run_as_user "cd '$REPO_DIR' && printf 'Current commit: '; git rev-parse --short HEAD"
