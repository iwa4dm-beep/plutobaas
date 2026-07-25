#!/usr/bin/env bash
# Install /usr/local/sbin/pluto-ops + sudoers rule so the sandbox worker
# can invoke it via `sudo -n`. Idempotent.
#
#   sudo bash pluto-backend/deploy/install-pluto-ops.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/pluto-ops.sh"
DST="/usr/local/sbin/pluto-ops"
SUDOERS="/etc/sudoers.d/pluto-ops"

[ "$(id -u)" = "0" ] || { echo "must run as root" >&2; exit 1; }
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

install -m 0755 -o root -g root "$SRC" "$DST"
echo "✓ installed $DST"

# Detect the user the sandbox worker runs as (default: pluto).
WORKER_USER="${WORKER_USER:-}"
if [ -z "$WORKER_USER" ] && [ -f /etc/systemd/system/pluto-sandbox-worker.service ]; then
  WORKER_USER=$(awk -F= '/^User=/{print $2; exit}' /etc/systemd/system/pluto-sandbox-worker.service | tr -d ' ')
fi
[ -n "$WORKER_USER" ] || WORKER_USER=pluto

umask 077
cat >"$SUDOERS.tmp" <<EOF
# Allow the sandbox worker to run whitelisted ops actions with no password.
$WORKER_USER ALL=(root) NOPASSWD: $DST
Defaults!$DST !requiretty
EOF
visudo -c -f "$SUDOERS.tmp" >/dev/null
mv "$SUDOERS.tmp" "$SUDOERS"
chmod 0440 "$SUDOERS"
echo "✓ sudoers rule installed at $SUDOERS (user=$WORKER_USER)"

echo "✓ pluto-ops ready — test with:  sudo -u $WORKER_USER sudo -n $DST service-health"
