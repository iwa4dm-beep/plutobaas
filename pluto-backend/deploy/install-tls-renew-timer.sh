#!/usr/bin/env bash
# install-tls-renew-timer.sh — installs the systemd unit + timer that runs
# tls-renew.sh + tls-alert.sh daily. Safe to re-run.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "✗ run as root (sudo)"; exit 2; }

here="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$here/.." && pwd)"

# Rewrite ExecStart to the actual repo path so packaged unit works from
# whatever checkout the operator uses.
UNIT_SRC="$here/systemd/pluto-tls-renew.service"
UNIT_DST="/etc/systemd/system/pluto-tls-renew.service"
TIMER_SRC="$here/systemd/pluto-tls-renew.timer"
TIMER_DST="/etc/systemd/system/pluto-tls-renew.timer"

sed "s|/root/backend-joy/pluto-backend|${ROOT}|g" "$UNIT_SRC" >"$UNIT_DST"
cp -f "$TIMER_SRC" "$TIMER_DST"
chmod +x "$here/tls-renew.sh" "$here/tls-alert.sh"

install -d -m 0755 /var/log/pluto /var/lib/pluto /etc/pluto

# Configure the alert endpoint if the operator supplied one.
if [ -n "${TLS_ALERT_URL:-}" ] || [ -n "${TLS_ALERT_SECRET:-}" ]; then
  {
    [ -n "${TLS_ALERT_URL:-}" ]    && echo "TLS_ALERT_URL='${TLS_ALERT_URL}'"
    [ -n "${TLS_ALERT_SECRET:-}" ] && echo "TLS_ALERT_SECRET='${TLS_ALERT_SECRET}'"
  } >/etc/pluto/tls-alert.env
  chmod 600 /etc/pluto/tls-alert.env
  echo "▶ wrote /etc/pluto/tls-alert.env"
fi

systemctl daemon-reload
systemctl enable --now pluto-tls-renew.timer
systemctl list-timers --all | grep pluto-tls-renew || true

echo "✓ pluto-tls-renew.timer installed"
echo "  Trigger now:   sudo systemctl start pluto-tls-renew.service"
echo "  Inspect log:   sudo tail -f /var/log/pluto/tls-renew.log"
echo "  Status file:   /var/lib/pluto/tls-status.json"
