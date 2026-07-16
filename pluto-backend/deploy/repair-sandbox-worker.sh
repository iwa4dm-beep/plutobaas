#!/usr/bin/env bash
# repair-sandbox-worker.sh — emergency repair for sandbox worker EADDRINUSE loops.
#
# Fixes the common VPS state where both an old `pluto-sandbox` service and the
# new `pluto-sandbox-worker` service (or a stray node process) fight for
# 127.0.0.1:8787, leaving systemd stuck in `activating` with EADDRINUSE.
#
# Usage:
#   sudo SECRET='<PLUTO_SANDBOX_WORKER_SECRET>' \
#        SERVICE_KEY='<service-role-key>' \
#        UPSTREAM='https://<project-ref>.supabase.co' \
#        bash deploy/repair-sandbox-worker.sh

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "✗ run as root"; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORKER_SRC="$ROOT/sandbox-worker/sandbox-worker.mjs"
UNIT="${UNIT:-pluto-sandbox-worker}"
ENV_FILE="${ENV_FILE:-/etc/pluto/sandbox-worker.env}"
PORT="${PORT:-8787}"
SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"

read_env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}

SECRET="${SECRET:-${SANDBOX_SHARED_SECRET:-$(read_env_value SANDBOX_SHARED_SECRET)}}"
SERVICE_KEY="${SERVICE_KEY:-${PLUTO_SERVICE_ROLE_KEY:-$(read_env_value PLUTO_SERVICE_ROLE_KEY)}}"
UPSTREAM="${UPSTREAM:-${PLUTO_UPSTREAM_URL:-$(read_env_value PLUTO_UPSTREAM_URL)}}"

[ -f "$WORKER_SRC" ] || { echo "✗ missing worker source: $WORKER_SRC"; exit 2; }
[ -n "$SECRET" ] || { echo "✗ SECRET is required and no existing SANDBOX_SHARED_SECRET was found"; exit 2; }
if [ -z "$UPSTREAM" ]; then
  echo "✗ UPSTREAM is required and no existing PLUTO_UPSTREAM_URL was found"
  echo "  Re-run with: UPSTREAM='https://<project-ref>.supabase.co'"
  exit 2
fi

echo "▶ Installing required diagnostics/tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends curl ca-certificates unzip psmisc iproute2 procps >/dev/null

echo "▶ Disabling legacy conflicting service: pluto-sandbox.service"
if systemctl list-unit-files pluto-sandbox.service >/dev/null 2>&1; then
  systemctl disable --now pluto-sandbox.service 2>/dev/null || true
  systemctl mask pluto-sandbox.service 2>/dev/null || true
fi

echo "▶ Resetting worker port"
if [ -x "$HERE/reset-sandbox-worker-port.sh" ]; then
  bash "$HERE/reset-sandbox-worker-port.sh" "$PORT"
else
  systemctl stop "$UNIT" 2>/dev/null || true
  systemctl kill --kill-who=all "$UNIT" 2>/dev/null || true
  systemctl reset-failed "$UNIT" 2>/dev/null || true
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  pkill -f 'node .*sandbox-worker\.mjs' 2>/dev/null || true
fi

echo "▶ Installing worker files"
install -d -m 0755 /opt/pluto/sandbox-worker
install -m 0755 "$WORKER_SRC" /opt/pluto/sandbox-worker/sandbox-worker.mjs
install -d -o www-data -g www-data -m 0755 "$SITES_ROOT"
install -d -m 0750 "$(dirname "$ENV_FILE")"

if [ -f "$HERE/reset-sandbox-worker-port.sh" ]; then
  install -m 0755 "$HERE/reset-sandbox-worker-port.sh" /opt/pluto/sandbox-worker/reset-sandbox-worker-port.sh
fi
cat > /opt/pluto/sandbox-worker/free-port.sh <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
PORT="${SANDBOX_WORKER_PORT:-${PORT:-8787}}"
UNIT="${UNIT:-pluto-sandbox-worker}"
if [ -x /opt/pluto/sandbox-worker/reset-sandbox-worker-port.sh ]; then
  SKIP_TARGET_STOP=1 exec /opt/pluto/sandbox-worker/reset-sandbox-worker-port.sh "$PORT"
fi
echo "missing /opt/pluto/sandbox-worker/reset-sandbox-worker-port.sh" >&2
exit 1
EOF
chmod 0755 /opt/pluto/sandbox-worker/free-port.sh

cat > /opt/pluto/sandbox-worker/repair-site-link.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SLUG="${1:?slug required}"
SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"
SLUG_PATH="${SITES_ROOT}/${SLUG}"
[ -e "$SLUG_PATH" ] && exit 0
MATCHES="$(grep -Rsl '"slug"[[:space:]]*:[[:space:]]*"'"$SLUG"'"' "$SITES_ROOT"/*/current.json "$SITES_ROOT"/*/preview.json 2>/dev/null | sed 's#/[^/]*\.json$##' | sort -u || true)"
COUNT="$(printf '%s\n' "$MATCHES" | sed '/^$/d' | wc -l | tr -d ' ')"
if [ "$COUNT" = "1" ]; then
  TARGET="$(printf '%s\n' "$MATCHES" | sed '/^$/d' | head -1)"
  ln -s "$(basename "$TARGET")" "$SLUG_PATH"
  echo "✓ repaired slug symlink: $SLUG_PATH -> $(basename "$TARGET")"
  exit 0
fi
echo "✗ cannot repair slug '$SLUG': no unique manifest match under $SITES_ROOT" >&2
exit 1
EOF
chmod 0755 /opt/pluto/sandbox-worker/repair-site-link.sh

echo "▶ Writing $ENV_FILE"
TMP="$(mktemp)"
cat > "$TMP" <<EOF
# Managed by deploy/repair-sandbox-worker.sh
SANDBOX_SHARED_SECRET=${SECRET}
PORT=${PORT}
SANDBOX_WORKER_PORT=${PORT}
SITES_ROOT=${SITES_ROOT}
SANDBOX_SITES_ROOT=${SITES_ROOT}
PLUTO_UPSTREAM_URL=${UPSTREAM}
EOF
[ -n "$SERVICE_KEY" ] && echo "PLUTO_SERVICE_ROLE_KEY=${SERVICE_KEY}" >> "$TMP"
install -m 0640 -o root -g www-data "$TMP" "$ENV_FILE" 2>/dev/null || install -m 0600 -o root -g root "$TMP" "$ENV_FILE"
rm -f "$TMP"

echo "▶ Reinstalling ${UNIT}.service with hard port cleanup"
cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=Pluto Sandbox Worker (ZIP unpacker + static site host)
After=network-online.target
Wants=network-online.target
Conflicts=pluto-sandbox.service
StartLimitIntervalSec=60
StartLimitBurst=20

[Service]
Type=simple
User=www-data
Group=www-data
EnvironmentFile=${ENV_FILE}
ExecStartPre=+/opt/pluto/sandbox-worker/free-port.sh
ExecStart=/usr/bin/node /opt/pluto/sandbox-worker/sandbox-worker.mjs
Restart=on-failure
RestartSec=3s
KillMode=mixed
TimeoutStopSec=10s
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
systemctl unmask "$UNIT" 2>/dev/null || true
systemctl reset-failed "$UNIT" 2>/dev/null || true
systemctl enable "$UNIT" >/dev/null
systemctl start "$UNIT"

for i in 1 2 3 4 5 6 7 8 9 10; do
  STATE="$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
  [ "$STATE" = "active" ] && break
  [ "$STATE" = "failed" ] && break
  sleep 1
done

STATE="$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
if [ "$STATE" != "active" ]; then
  echo "✗ $UNIT state=$STATE"
  systemctl status "$UNIT" --no-pager -l || true
  journalctl -u "$UNIT" --no-pager -n 80 || true
  ss -ltnp "sport = :${PORT}" 2>/dev/null || true
  exit 1
fi

HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz")"
echo "  /healthz: $HEALTH"
if ! echo "$HEALTH" | grep -q 'v1-static-serve'; then
  echo "✗ worker is active, but stale code is still running (missing v1-static-serve)"
  exit 1
fi

echo "✓ ${UNIT}.service repaired and healthy"