#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BRANCH="dev"
ORIGIN_REMOTE="origin"
UPSTREAM_REMOTE="upstream"
DEPLOY_WRAPPER="/usr/local/sbin/opencode-vps-update"
CHECK_SCRIPT="./infra/scripts/check-vps-web-build.sh"
DRY_RUN=0
NO_DEPLOY=0
SKIP_PUSH=0

usage() {
  cat <<USAGE
Usage: ./infra/scripts/merge-upstream-dev.sh [--dry-run] [--no-deploy] [--skip-push]

Fetches origin/dev and upstream/dev, merges upstream/dev into the local dev branch, pushes to origin/dev, and optionally deploys via the VPS wrapper.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-deploy)
      NO_DEPLOY=1
      shift
      ;;
    --skip-push)
      SKIP_PUSH=1
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

cd "$REPO_DIR"

if [[ ! -x "$DEPLOY_WRAPPER" ]]; then
  echo "error: $DEPLOY_WRAPPER is not installed on this host" >&2
  echo "run: sudo ./infra/scripts/install-vps-update-wrapper.sh" >&2
  exit 1
fi

if [[ ! -x "$CHECK_SCRIPT" ]]; then
  echo "error: $CHECK_SCRIPT is missing or not executable" >&2
  exit 1
fi

status_output="$(git status --porcelain)"
if [[ -n "$status_output" ]]; then
  echo 'error: repo is dirty; refusing to merge upstream' >&2
  printf '%s\n' "$status_output" >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$BRANCH" ]]; then
  git checkout "$BRANCH"
fi

head_before_origin="$(git rev-parse HEAD)"

git fetch "$ORIGIN_REMOTE" "$BRANCH"
git fetch "$UPSTREAM_REMOTE" "$BRANCH"
git pull --ff-only "$ORIGIN_REMOTE" "$BRANCH"

$CHECK_SCRIPT --source-only

local_before="$(git rev-parse HEAD)"
origin_head="$(git rev-parse "$ORIGIN_REMOTE/$BRANCH")"
upstream_head="$(git rev-parse "$UPSTREAM_REMOTE/$BRANCH")"

printf 'Local dev:     %s\n' "$local_before"
printf 'Origin dev:    %s\n' "$origin_head"
printf 'Upstream dev:  %s\n' "$upstream_head"

if git merge-base --is-ancestor "$upstream_head" HEAD; then
  echo 'No new upstream commits to merge.'
  if [[ $DRY_RUN -eq 1 ]]; then
    exit 0
  fi
  if [[ "$head_before_origin" != "$local_before" ]]; then
    echo 'Local branch changed while fast-forwarding from origin.'
  fi
  if [[ $NO_DEPLOY -eq 0 && "$head_before_origin" != "$local_before" ]]; then
    sudo "$DEPLOY_WRAPPER" --skip-pull
  fi
  exit 0
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo 'Dry run: would merge upstream/dev into dev, push origin/dev, and deploy with the VPS wrapper.'
  exit 0
fi

git merge --no-edit "$UPSTREAM_REMOTE/$BRANCH"

$CHECK_SCRIPT --source-only

printf 'Merged commit: %s\n' "$(git rev-parse HEAD)"

if [[ $SKIP_PUSH -eq 0 ]]; then
  git push "$ORIGIN_REMOTE" "$BRANCH"
fi

if [[ $NO_DEPLOY -eq 0 ]]; then
  sudo "$DEPLOY_WRAPPER" --skip-pull
fi
