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
#   UPSTREAM=https://<project-ref>.supabase.co   (preserves existing value if omitted)
#   ALLOW_LOCAL_UPSTREAM=1                        (only if a local Pluto API really listens on 127.0.0.1)
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
UNIT="${UNIT:-pluto-sandbox-worker}"
ENV_FILE="${ENV_FILE:-/etc/pluto/sandbox-worker.env}"
SECRET="${SECRET:-${SANDBOX_SHARED_SECRET:-${PLUTO_SANDBOX_WORKER_SECRET:-}}}"
SERVICE_KEY="${SERVICE_KEY:-${PLUTO_SERVICE_ROLE_KEY:-}}"
UPSTREAM="${UPSTREAM:-${PLUTO_UPSTREAM_URL:-}}"

# Preserve a known-good upstream from the existing env file. This prevents a
# re-bootstrap from silently reverting storage fetches to 127.0.0.1:8000.
if [ -z "$UPSTREAM" ] && [ -f "$ENV_FILE" ]; then
  UPSTREAM="$(grep -E '^PLUTO_UPSTREAM_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
fi

if [ -z "$UPSTREAM" ]; then
  if [ "${ALLOW_LOCAL_UPSTREAM:-0}" = "1" ]; then
    UPSTREAM="http://127.0.0.1:8000"
  else
    echo "✗ UPSTREAM is required for a working /sandbox/unpack."
    echo "  Re-run with: UPSTREAM='https://<project-ref>.supabase.co'"
    echo "  If you intentionally run a local Pluto API on 127.0.0.1:8000, add ALLOW_LOCAL_UPSTREAM=1."
    exit 2
  fi
fi

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

stop_worker_units_and_free_port() {
  if [ -f "$HERE/reset-sandbox-worker-port.sh" ]; then
    bash "$HERE/reset-sandbox-worker-port.sh" "$PORT"
    return
  fi

  echo "▶ Stopping duplicate sandbox worker units and freeing 127.0.0.1:${PORT}"
  for u in pluto-sandbox-worker pluto-sandbox; do
    if systemctl list-unit-files "${u}.service" >/dev/null 2>&1; then
      systemctl stop "$u" 2>/dev/null || true
      systemctl kill --kill-who=all "$u" 2>/dev/null || true
      systemctl reset-failed "$u" 2>/dev/null || true
    fi
  done

  # Prefer fuser when present; fall back to ss parsing. This fixes EADDRINUSE
  # caused by an old unit or manually-started node process still holding 8787.
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    PIDS="$(ss -ltnp "sport = :${PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
    if [ -n "$PIDS" ]; then
      echo "$PIDS" | xargs -r kill 2>/dev/null || true
      sleep 1
      echo "$PIDS" | xargs -r kill -9 2>/dev/null || true
    fi
  else
    pkill -f 'node .*sandbox-worker\.mjs' 2>/dev/null || true
  fi
}

install_free_port_helper() {
  install -d -m 0755 /opt/pluto/sandbox-worker
  if [ -f "$HERE/reset-sandbox-worker-port.sh" ]; then
    install -m 0755 "$HERE/reset-sandbox-worker-port.sh" /opt/pluto/sandbox-worker/reset-sandbox-worker-port.sh
    cat > /opt/pluto/sandbox-worker/free-port.sh <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
PORT="${SANDBOX_WORKER_PORT:-${PORT:-8787}}"
UNIT="${UNIT:-pluto-sandbox-worker}"
SKIP_TARGET_STOP=1 exec /opt/pluto/sandbox-worker/reset-sandbox-worker-port.sh "$PORT"
EOF
  else
    cat > /opt/pluto/sandbox-worker/free-port.sh <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
PORT="${SANDBOX_WORKER_PORT:-${PORT:-8787}}"
if command -v ss >/dev/null 2>&1; then
  PIDS="$(ss -H -ltnp "sport = :${PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  for pid in $PIDS; do
    args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
    if printf '%s' "$args" | grep -Eq 'node .*sandbox-worker\.mjs|/opt/pluto/sandbox-worker'; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    else
      echo "port ${PORT} is busy by non-Pluto pid=${pid}: ${args}" >&2
      exit 1
    fi
  done
fi
exit 0
EOF
  fi
  chmod 0755 /opt/pluto/sandbox-worker/free-port.sh
}

echo "▶ Installing OS dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends curl ca-certificates unzip psmisc iproute2 procps >/dev/null
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi

echo "▶ Installing sandbox worker files"
install -d -m 0755 /opt/pluto/sandbox-worker
install -m 0755 "$WORKER_SRC" /opt/pluto/sandbox-worker/sandbox-worker.mjs
install_free_port_helper
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

echo "▶ Installing /usr/local/sbin/pluto-repair wrapper + sudoers rule"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
cat > /usr/local/sbin/pluto-repair <<PLUTO_REPAIR_EOF
#!/usr/bin/env bash
# Whitelisted repair dispatcher invoked by pluto-sandbox-worker via sudo.
# Accepts: <action> [--slug S] [--wildcard W] [--acme-email E]
set -euo pipefail
umask 022
DEPLOY_DIR="${DEPLOY_DIR}"
ACTION="\${1:-}"; shift || true
SLUG=""; WILDCARD=""; ACME_EMAIL=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --slug) SLUG="\${2:-}"; shift 2;;
    --wildcard) WILDCARD="\${2:-}"; shift 2;;
    --acme-email) ACME_EMAIL="\${2:-}"; shift 2;;
    *) echo "unknown arg: \$1" >&2; exit 2;;
  esac
done
run_one() {
  case "\$1" in
    worker-and-site) SLUG="\$SLUG" WILDCARD="\$WILDCARD" ACME_EMAIL="\$ACME_EMAIL" bash "\$DEPLOY_DIR/repair-sandbox-worker-and-site.sh";;
    wildcard-ssl)    APEX="\${WILDCARD:-app.timescard.cloud}" ACME_EMAIL="\$ACME_EMAIL" bash "\$DEPLOY_DIR/fix-wildcard-ssl.sh" "\$SLUG";;
    deploy-and-verify) SLUG="\$SLUG" bash "\$DEPLOY_DIR/deploy-and-verify.sh";;
    *) echo "unknown action: \$1" >&2; exit 2;;
  esac
}
case "\$ACTION" in
  all)
    run_one worker-and-site
    run_one wildcard-ssl
    run_one deploy-and-verify
    ;;
  worker-and-site|wildcard-ssl|deploy-and-verify) run_one "\$ACTION";;
  *) echo "invalid action: \$ACTION" >&2; exit 2;;
esac
PLUTO_REPAIR_EOF
chmod 0755 /usr/local/sbin/pluto-repair
cat > /etc/sudoers.d/pluto-worker <<'SUDOERS_EOF'
www-data ALL=(root) NOPASSWD: /usr/local/sbin/pluto-repair
Defaults!/usr/local/sbin/pluto-repair !requiretty
SUDOERS_EOF
chmod 0440 /etc/sudoers.d/pluto-worker
visudo -c -f /etc/sudoers.d/pluto-worker >/dev/null

echo "▶ Installing systemd unit: ${UNIT}.service"
if [ "$UNIT" = "pluto-sandbox-worker" ] && systemctl list-unit-files pluto-sandbox.service >/dev/null 2>&1; then
  echo "▶ Disabling legacy conflicting service: pluto-sandbox.service"
  systemctl disable --now pluto-sandbox.service 2>/dev/null || true
  systemctl mask pluto-sandbox.service 2>/dev/null || true
fi
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
# NoNewPrivileges intentionally NOT set — the worker sudo-runs
# /usr/local/sbin/pluto-repair (whitelisted, NOPASSWD) for one-click repair.
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
stop_worker_units_and_free_port
systemctl enable "$UNIT"
systemctl start "$UNIT"
for i in 1 2 3 4 5; do
  sleep 1
  STATE="$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
  [ "$STATE" = "activating" ] || break
done

STATE="$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
if [ "$STATE" != "active" ]; then
  echo "✗ $UNIT state=$STATE"
  journalctl -u "$UNIT" --no-pager -n 60
  exit 1
fi

echo "▶ Probing http://127.0.0.1:${PORT}/healthz"
HEALTH=""
for i in $(seq 1 30); do
  if HEALTH="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null)"; then
    break
  fi
  STATE_NOW="$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
  if [ "$STATE_NOW" = "failed" ]; then
    echo "✗ $UNIT failed while waiting for /healthz"
    journalctl -u "$UNIT" --no-pager -n 80 || true
    exit 1
  fi
  sleep 1
done
[ -n "$HEALTH" ] || { echo "✗ worker never responded on 127.0.0.1:${PORT}/healthz"; systemctl status "$UNIT" --no-pager -l || true; journalctl -u "$UNIT" --no-pager -n 80 || true; exit 1; }
echo "$HEALTH"; echo
if ! echo "$HEALTH" | grep -q 'v1-static-serve'; then
  echo "✗ worker responded, but the static-serving version marker is missing."
  echo "  The running service is stale; run: sudo bash deploy/refresh-worker.sh"
  exit 1
fi

echo "✓ ${UNIT}.service is active and healthy"
if [ "$GENERATED" = "1" ]; then
  echo
  echo "COPY THIS → PLUTO_SANDBOX_WORKER_SECRET = ${SECRET}"
fi
echo "Set PLUTO_SANDBOX_URL to: https://api.timescard.cloud/sandbox"