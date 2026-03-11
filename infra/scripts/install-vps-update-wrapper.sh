#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_DIR/infra/scripts/opencode-vps-update-wrapper.sh"
DST="/usr/local/sbin/opencode-vps-update"
SUDOERS="/etc/sudoers.d/opencode-vps-update"
RUN_AS="${RUN_AS:-clawd}"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  exec sudo "$0" "$@"
fi

if [[ ! -f "$SRC" ]]; then
  echo "error: wrapper template not found: $SRC" >&2
  exit 1
fi

install -o root -g root -m 755 "$SRC" "$DST"
cat > "$SUDOERS" <<EOF2
${RUN_AS} ALL=(root) NOPASSWD: ${DST}
EOF2
chmod 440 "$SUDOERS"
visudo -cf "$SUDOERS"

echo "Installed: $DST"
echo "Installed: $SUDOERS"
