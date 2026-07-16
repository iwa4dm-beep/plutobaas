#!/usr/bin/env bash
# Rewrite /etc/pluto/sandbox-worker.env so SANDBOX_SHARED_SECRET matches
# PLUTO_SANDBOX_WORKER_SECRET (the value stored in the Lovable dashboard),
# then restart pluto-sandbox-worker and confirm it stays running.
#
# Usage:
#   sudo SECRET='paste-the-lovable-secret-here' \
#        SERVICE_KEY='paste-the-service-role-key-here' \
#        bash pluto-backend/deploy/fix-worker-env.sh
#
# Optional env:
#   ENV_FILE   default /etc/pluto/sandbox-worker.env
#   UNIT       default auto-detects pluto-sandbox-worker, then pluto-sandbox
#   PORT       default 8787
#   SITES_ROOT default /var/lib/pluto/sites
#   UPSTREAM   default http://127.0.0.1:8000

set -uo pipefail

SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"

ENV_FILE="${ENV_FILE:-/etc/pluto/sandbox-worker.env}"
UNIT="${UNIT:-}"
PORT="${PORT:-8787}"
SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"
UPSTREAM="${UPSTREAM:-}"

SECRET="${SECRET:-}"
SERVICE_KEY="${SERVICE_KEY:-}"

if [ -z "$SECRET" ]; then
  echo "✗ SECRET is required. Pass it inline:"
  echo "   sudo SECRET='<PLUTO_SANDBOX_WORKER_SECRET>' \\"
  echo "        SERVICE_KEY='<supabase service role key>' \\"
  echo "        UPSTREAM='https://<project-ref>.supabase.co' \\"
  echo "        bash $0"
  exit 2
fi

# Try to preserve existing UPSTREAM if the caller didn't override it.
if [ -z "$UPSTREAM" ] && [ -f "$ENV_FILE" ]; then
  UPSTREAM="$(grep -E '^PLUTO_UPSTREAM_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
fi
if [ -z "$UPSTREAM" ]; then
  UPSTREAM="http://127.0.0.1:8000"
  echo "⚠ UPSTREAM not set — defaulting to $UPSTREAM."
  echo "   POST /unpack will fail with 'fetch failed' until you set UPSTREAM to your"
  echo "   Supabase project URL (e.g. https://xxxx.supabase.co) and rerun this script."
fi

if [ -z "$UNIT" ]; then
  if $SUDO systemctl list-unit-files pluto-sandbox-worker.service >/dev/null 2>&1; then
    UNIT="pluto-sandbox-worker"
  elif $SUDO systemctl list-unit-files pluto-sandbox.service >/dev/null 2>&1; then
    UNIT="pluto-sandbox"
  else
    UNIT="pluto-sandbox-worker"
  fi
fi

$SUDO mkdir -p "$(dirname "$ENV_FILE")"
TMP="$(mktemp)"
cat > "$TMP" <<EOF
# Managed by deploy/fix-worker-env.sh — edit inline vars, not this comment.
SANDBOX_SHARED_SECRET=${SECRET}
PORT=${PORT}
SANDBOX_WORKER_PORT=${PORT}
SITES_ROOT=${SITES_ROOT}
SANDBOX_SITES_ROOT=${SITES_ROOT}
PLUTO_UPSTREAM_URL=${UPSTREAM}
EOF
if [ -n "$SERVICE_KEY" ]; then
  echo "PLUTO_SERVICE_ROLE_KEY=${SERVICE_KEY}" >> "$TMP"
else
  # Preserve any existing service role key from the current file.
  if [ -f "$ENV_FILE" ]; then
    OLD_KEY="$(grep -E '^PLUTO_SERVICE_ROLE_KEY=' "$ENV_FILE" | tail -1 || true)"
    [ -n "$OLD_KEY" ] && echo "$OLD_KEY" >> "$TMP"
  fi
fi

$SUDO install -m 0640 -o root -g root "$TMP" "$ENV_FILE"
rm -f "$TMP"
echo "✓ wrote $ENV_FILE"
echo "  keys: $(grep -c '=' "$ENV_FILE") lines"

echo "▶ Restarting $UNIT"
$SUDO systemctl restart "$UNIT" || { echo "✗ restart failed"; $SUDO systemctl status "$UNIT" --no-pager -l; exit 1; }

sleep 2
STATE="$($SUDO systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
if [ "$STATE" = "active" ]; then
  echo "✓ $UNIT is active"
else
  echo "✗ $UNIT state=$STATE — recent logs:"
  $SUDO journalctl -u "$UNIT" --no-pager -n 40
  exit 1
fi

echo "▶ Probing worker healthz…"
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" | head -c 400; then
  echo; echo "✓ worker healthy on 127.0.0.1:${PORT}"
else
  echo "✗ worker did not respond on 127.0.0.1:${PORT}"
  exit 1
fi
