#!/usr/bin/env bash
# nuke-and-rebuild-sandbox.sh — সম্পূর্ণভাবে sandbox worker মুছে দিয়ে
# নতুন করে সব কিছু bootstrap করে।
#
# WARNING: এটা /opt/pluto/sandbox-worker, /etc/pluto/sandbox-worker.env,
# systemd unit ফাইল, এবং (KEEP_SITES=1 না দিলে) /var/lib/pluto/sites সব
# মুছে দেয়। Deployed site গুলো আবার Auto-Deploy চালিয়ে ফেরত আনতে হবে।
#
# Usage (সব value আসল হতে হবে — placeholder < > সহ নয়):
#   sudo SECRET='আসল-shared-secret' \
#        SERVICE_KEY='sb_secret_xxx...' \
#        UPSTREAM='https://abcxyz.supabase.co' \
#        WILDCARD='app.timescard.cloud' \
#        ACME_EMAIL='admin@timescard.cloud' \
#        SLUG='dbhstock-8myjt4' \
#        bash deploy/nuke-and-rebuild-sandbox.sh
#
# Optional:
#   KEEP_SITES=1  → /var/lib/pluto/sites মুছবে না (deployed bundle বাঁচবে)
#   PORT=8787
#   TAKEOVER_PORT=1 → 8787 Pluto-র জন্য dedicated ধরে non-Pluto listener-ও সরাবে

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "✗ run as root (sudo)"; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8787}"
WILDCARD="${WILDCARD:-app.timescard.cloud}"
ACME_EMAIL="${ACME_EMAIL:-admin@${WILDCARD#*.}}"
SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"
TAKEOVER_PORT="${TAKEOVER_PORT:-1}"

log(){ printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- Validate real values (reject placeholder strings) ----
looks_like_placeholder() {
  case "$1" in
    *"<"*">"*) return 0 ;;
    "") return 0 ;;
    *) return 1 ;;
  esac
}

[ -n "${SECRET:-}" ]      || die "SECRET env required"
[ -n "${SERVICE_KEY:-}" ] || die "SERVICE_KEY env required"
[ -n "${UPSTREAM:-}" ]    || die "UPSTREAM env required (e.g. https://abcxyz.supabase.co)"

looks_like_placeholder "$SECRET"      && die "SECRET looks like a literal placeholder — বসান আসল shared secret"
looks_like_placeholder "$SERVICE_KEY" && die "SERVICE_KEY placeholder — বসান আসল Supabase service role key"
looks_like_placeholder "$UPSTREAM"    && die "UPSTREAM placeholder — বসান আসল project URL (https://<ref>.supabase.co এ <ref> replace করুন)"

echo "$UPSTREAM" | grep -Eq '^https?://[a-zA-Z0-9._-]+' || die "UPSTREAM must be a real https URL"

cd "$ROOT"

# ---- 1. Stop & disable everything ----
log "1/7 stopping & disabling all sandbox units"
for u in pluto-sandbox-worker pluto-sandbox; do
  systemctl stop    "$u" 2>/dev/null || true
  systemctl disable "$u" 2>/dev/null || true
  systemctl kill --kill-who=all "$u" 2>/dev/null || true
  systemctl reset-failed "$u" 2>/dev/null || true
  rm -f "/etc/systemd/system/${u}.service"
done
systemctl mask pluto-sandbox.service 2>/dev/null || true
systemctl daemon-reload

log "1b/7 identifying and freeing 127.0.0.1:${PORT}"
if [ -f "$HERE/reset-sandbox-worker-port.sh" ]; then
  FORCE_PORT_TAKEOVER="$TAKEOVER_PORT" bash "$HERE/reset-sandbox-worker-port.sh" "$PORT"
else
  pkill -9 -f 'node .*sandbox-worker\.mjs' 2>/dev/null || true
  command -v fuser >/dev/null 2>&1 && fuser -k "${PORT}/tcp" 2>/dev/null || true
fi

# ---- 2. Wipe filesystem state ----
log "2/7 wiping install & env"
rm -rf /opt/pluto/sandbox-worker
rm -f  /etc/pluto/sandbox-worker.env
if [ "${KEEP_SITES:-0}" = "1" ]; then
  echo "  KEEP_SITES=1 → keeping ${SITES_ROOT}"
else
  echo "  wiping ${SITES_ROOT} (re-run Auto Deploy after this)"
  rm -rf "${SITES_ROOT}"
fi

# ---- 3. OS deps ----
log "3/7 installing OS deps"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends \
  curl ca-certificates unzip nginx psmisc iproute2 procps >/dev/null
# node (assume already installed; verify)
command -v node >/dev/null || die "node not installed — install Node.js 20+ first"

# ---- 4. Fresh install worker ----
log "4/7 installing worker files"
install -d -m 0755 /opt/pluto/sandbox-worker
install -m 0755 "$ROOT/sandbox-worker/sandbox-worker.mjs" /opt/pluto/sandbox-worker/sandbox-worker.mjs
install -d -o www-data -g www-data -m 0755 "$SITES_ROOT"
install -d -m 0750 /etc/pluto

# port-free helper
install -m 0755 "$HERE/reset-sandbox-worker-port.sh" /opt/pluto/sandbox-worker/reset-sandbox-worker-port.sh
cat > /opt/pluto/sandbox-worker/free-port.sh <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
PORT="${SANDBOX_WORKER_PORT:-${PORT:-8787}}"
SKIP_TARGET_STOP=1 exec /opt/pluto/sandbox-worker/reset-sandbox-worker-port.sh "$PORT"
EOF
chmod 0755 /opt/pluto/sandbox-worker/free-port.sh

# ---- 5. Env file ----
log "5/7 writing /etc/pluto/sandbox-worker.env"
TMP="$(mktemp)"
cat > "$TMP" <<EOF
# Managed by deploy/nuke-and-rebuild-sandbox.sh
SANDBOX_SHARED_SECRET=${SECRET}
PORT=${PORT}
SANDBOX_WORKER_PORT=${PORT}
SITES_ROOT=${SITES_ROOT}
SANDBOX_SITES_ROOT=${SITES_ROOT}
PLUTO_UPSTREAM_URL=${UPSTREAM}
PLUTO_SERVICE_ROLE_KEY=${SERVICE_KEY}
PLUTO_WILDCARD_HOST=${WILDCARD}
EOF
install -m 0640 -o root -g www-data "$TMP" /etc/pluto/sandbox-worker.env 2>/dev/null \
  || install -m 0600 "$TMP" /etc/pluto/sandbox-worker.env
rm -f "$TMP"

# ---- 6. systemd unit ----
log "6/7 installing systemd unit"
cat > /etc/systemd/system/pluto-sandbox-worker.service <<EOF
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
EnvironmentFile=/etc/pluto/sandbox-worker.env
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
systemctl enable pluto-sandbox-worker >/dev/null
systemctl start  pluto-sandbox-worker

# Wait for actual /healthz (not just is-active)
log "7/7 waiting for /healthz on 127.0.0.1:${PORT}"
HEALTH=""
for i in $(seq 1 20); do
  if HEALTH="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null)"; then
    break
  fi
  STATE_NOW="$(systemctl is-active pluto-sandbox-worker 2>/dev/null || echo unknown)"
  if [ "$STATE_NOW" = "failed" ]; then
    echo "✗ worker service failed. Last logs:"
    journalctl -u pluto-sandbox-worker --no-pager -n 60
    exit 1
  fi
  sleep 1
done
[ -n "$HEALTH" ] || { echo "✗ worker never responded"; journalctl -u pluto-sandbox-worker --no-pager -n 60; exit 1; }
echo "  /healthz: $HEALTH"
echo "$HEALTH" | grep -q 'v1-static-serve' || die "worker responded but stale code is running (missing v1-static-serve marker)"

# ---- nginx sites-proxy ----
log "installing nginx sites-proxy (wildcard=${WILDCARD})"
ACME_EMAIL="$ACME_EMAIL" bash "$HERE/install-sites-proxy.sh" --wildcard "$WILDCARD" || die "install-sites-proxy failed"
nginx -t
systemctl reload nginx

printf '\n\033[1;32m✓ sandbox worker rebuilt from scratch and healthy\033[0m\n'
echo
echo "Next steps:"
echo "  1) UI → Auto Deploy আবার চালান (SLUG=${SLUG:-<your-slug>}). এটা /sandbox/unpack call করে bundle push করবে।"
echo "  2) তারপর verify করুন:"
echo "       bash deploy/verify-deploy.sh ${SLUG:-<your-slug>}"
echo "  3) https://${WILDCARD%%.*}.${WILDCARD#*.}/sites/${SLUG:-<your-slug>}/ ব্রাউজে খুলে দেখুন।"
