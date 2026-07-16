#!/usr/bin/env bash
# One-command VPS bootstrap for pluto-sandbox-worker.
#
# Installs Node/unzip, copies sandbox-worker.mjs, writes
# /etc/pluto/sandbox-worker.env, creates pluto-sandbox-worker.service,
# starts it, and verifies /healthz.
#
# Usage from repo root or pluto-backend/:
#   sudo SECRET='<PLUTO_SANDBOX_WORKER_SECRET>' \
#        SERVICE_KEY='<service-role-key>' \
#        bash deploy/bootstrap-sandbox-worker.sh
#
# Optional env:
#   PORT=8787
#   SITES_ROOT=/var/lib/pluto/sites
#   UPSTREAM=http://127.0.0.1:8000
#   UNIT=pluto-sandbox-worker
#   ENV_FILE=/etc/pluto/sandbox-worker.env

set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "✗ run as root: sudo bash deploy/bootstrap-sandbox-worker.sh"
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
WORKER_SRC="$REPO_ROOT/sandbox-worker/sandbox-worker.mjs"

PORT="${PORT:-8787}"
SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"
UPSTREAM="${UPSTREAM:-http://127.0.0.1:8000}"
UNIT="${UNIT:-pluto-sandbox-worker}"
ENV_FILE="${ENV_FILE:-/etc/pluto/sandbox-worker.env}"
SECRET="${SECRET:-${SANDBOX_SHARED_SECRET:-${PLUTO_SANDBOX_WORKER_SECRET:-}}}"
SERVICE_KEY="${SERVICE_KEY:-${PLUTO_SERVICE_ROLE_KEY:-}}"

if [ ! -f "$WORKER_SRC" ]; then
  echo "✗ missing worker source: $WORKER_SRC"
  echo "  Run this from the cloned pluto-backend checkout."
  exit 1
fi

if [ -z "$SECRET" ]; then
  SECRET="$(openssl rand -hex 32)"
  GENERATED=1
else
  GENERATED=0
fi

echo "▶ Installing OS dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends curl ca-certificates unzip >/dev/null
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi

echo "▶ Installing sandbox worker files"
install -d -m 0755 /opt/pluto/sandbox-worker
install -m 0755 "$WORKER_SRC" /opt/pluto/sandbox-worker/sandbox-worker.mjs
install -d -o www-data -g www-data -m 0755 "$SITES_ROOT"
install -d -m 0750 "$(dirname "$ENV_FILE")"

echo "▶ Writing $ENV_FILE"
TMP="$(mktemp)"
cat > "$TMP" <<EOF
# Managed by deploy/bootstrap-sandbox-worker.sh
SANDBOX_SHARED_SECRET=${SECRET}
PORT=${PORT}
SANDBOX_WORKER_PORT=${PORT}
SITES_ROOT=${SITES_ROOT}
SANDBOX_SITES_ROOT=${SITES_ROOT}
PLUTO_UPSTREAM_URL=${UPSTREAM}
EOF
if [ -n "$SERVICE_KEY" ]; then
  echo "PLUTO_SERVICE_ROLE_KEY=${SERVICE_KEY}" >> "$TMP"
elif [ -f "$ENV_FILE" ]; then
  grep -E '^PLUTO_SERVICE_ROLE_KEY=' "$ENV_FILE" >> "$TMP" || true
fi
install -m 0640 -o root -g www-data "$TMP" "$ENV_FILE" 2>/dev/null || install -m 0600 -o root -g root "$TMP" "$ENV_FILE"
rm -f "$TMP"

echo "▶ Installing systemd unit: ${UNIT}.service"
cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=Pluto Sandbox Worker (ZIP unpacker + static site host)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node /opt/pluto/sandbox-worker/sandbox-worker.mjs
Restart=on-failure
RestartSec=3s
StandardOutput=journal
StandardError=journal
ReadWritePaths=${SITES_ROOT}
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT"
systemctl restart "$UNIT"
sleep 2

STATE="$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
if [ "$STATE" != "active" ]; then
  echo "✗ $UNIT state=$STATE"
  journalctl -u "$UNIT" --no-pager -n 60
  exit 1
fi

echo "▶ Probing http://127.0.0.1:${PORT}/healthz"
curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz"; echo

echo "✓ ${UNIT}.service is active and healthy"
if [ "$GENERATED" = "1" ]; then
  echo
  echo "COPY THIS → PLUTO_SANDBOX_WORKER_SECRET = ${SECRET}"
fi
echo "Set PLUTO_SANDBOX_URL to: https://api.timescard.cloud/sandbox"