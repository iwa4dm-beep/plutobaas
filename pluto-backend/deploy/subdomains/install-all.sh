#!/usr/bin/env bash
# One-command: render nginx → issue certs → verify HTTPS.
# See ./README.md for env vars.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi

HERE="$(cd "$(dirname "$0")" && pwd)"

bash "$HERE/render-nginx.sh"
bash "$HERE/issue-certs.sh"
bash "$HERE/verify-https.sh"

echo
echo "Renewal is handled by the system certbot timer:"
echo "  systemctl list-timers | grep certbot"
echo "To force a dry-run renewal:  certbot renew --dry-run"
