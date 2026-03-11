#!/usr/bin/env bash
set -euo pipefail

WRAPPER="/usr/local/sbin/opencode-vps-update"

if [[ ! -x "$WRAPPER" ]]; then
  echo "error: $WRAPPER is not installed on this host" >&2
  echo "run: sudo ./infra/scripts/install-vps-update-wrapper.sh" >&2
  exit 1
fi

exec sudo "$WRAPPER" "$@"
