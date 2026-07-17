#!/usr/bin/env bash
# Prints the VPS sandbox-worker shared secret so you can paste it into
# Lovable Cloud → Secrets → PLUTO_SANDBOX_SECRET.
#
# Usage (on the VPS):
#   sudo bash deploy/print-sandbox-secret.sh
#
# If no secret exists yet, one is generated, appended to
# /etc/pluto/sandbox-worker.env, and the worker restarted.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/pluto/sandbox-worker.env}"
UNIT="${UNIT:-pluto-sandbox-worker}"

if [ "$(id -u)" != "0" ]; then
  echo "✗ run as root: sudo bash $0"
  exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"

SECRET="$(grep -E '^SANDBOX_SHARED_SECRET=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"

if [ -z "$SECRET" ]; then
  SECRET="$(openssl rand -hex 32)"
  echo "SANDBOX_SHARED_SECRET=${SECRET}" >> "$ENV_FILE"
  chmod 0640 "$ENV_FILE" || true
  systemctl restart "$UNIT" 2>/dev/null || true
  echo "▶ generated new SANDBOX_SHARED_SECRET and restarted ${UNIT}"
fi

echo
echo "==================== COPY THIS ===================="
echo "PLUTO_SANDBOX_SECRET = ${SECRET}"
echo "==================================================="
echo
echo "Paste it in Lovable Cloud → Secrets → PLUTO_SANDBOX_SECRET, save, then re-run Auto Deploy."
