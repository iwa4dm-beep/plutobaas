#!/usr/bin/env bash
# Install / reinstall systemd units for Pluto backend + migration runner.
#   sudo bash deploy/install-systemd.sh
#
# Units installed:
#   pluto-backend.service   — docker compose stack (auto-restart on failure)
#   pluto-migrator.service  — one-shot migration runner
#   pluto-migrator.timer    — runs migrator 60s after boot, then every 5min
#
# Logs:
#   journalctl -u pluto-backend  -f
#   journalctl -u pluto-migrator -f
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"

echo "▶ installing systemd units from $ROOT/deploy/systemd/"
for u in pluto-backend.service pluto-migrator.service pluto-migrator.timer; do
  src="$ROOT/deploy/systemd/$u"
  [ -f "$src" ] || { echo "❌ missing $src" >&2; exit 1; }
  $SUDO install -m 0644 "$src" "/etc/systemd/system/$u"
  echo "  ✔ /etc/systemd/system/$u"
done

echo "▶ systemctl daemon-reload"
$SUDO systemctl daemon-reload

echo "▶ enable + start pluto-backend.service"
$SUDO systemctl enable --now pluto-backend.service

echo "▶ enable + start pluto-migrator.timer (migrator runs 60s after boot)"
$SUDO systemctl enable --now pluto-migrator.timer

echo
echo "✅ Installed. Useful commands:"
echo "  systemctl status pluto-backend --no-pager"
echo "  systemctl status pluto-migrator.timer --no-pager"
echo "  journalctl -u pluto-backend  -f"
echo "  journalctl -u pluto-migrator -f"
