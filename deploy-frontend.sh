#!/usr/bin/env bash
# ============================================================
# Pluto BaaS — Frontend Deploy Script (VPS)
# Usage:  sudo bash /root/backend-joy/deploy-frontend.sh
# ============================================================
set -euo pipefail

APP_DIR="/root/backend-joy"
SERVICE="pluto-dashboard"
PORT="3001"
BUN_BIN="${BUN_BIN:-/root/.bun/bin/bun}"

log() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }

# ---------- 0. Sanity ----------
[ -d "$APP_DIR" ] || { echo "❌ $APP_DIR not found"; exit 1; }
cd "$APP_DIR"

if [ ! -x "$BUN_BIN" ]; then
  warn "bun not found at $BUN_BIN — installing"
  curl -fsSL https://bun.sh/install | bash
  export PATH="/root/.bun/bin:$PATH"
  BUN_BIN="/root/.bun/bin/bun"
fi

# ---------- 1. Pull latest ----------
log "Pulling latest code from GitHub"
git fetch --all --prune
git reset --hard origin/"$(git rev-parse --abbrev-ref HEAD)"
ok "Repo updated to $(git rev-parse --short HEAD)"

# ---------- 2. Install deps ----------
log "Installing dependencies (bun install)"
"$BUN_BIN" install --frozen-lockfile || "$BUN_BIN" install
ok "Dependencies installed"

# ---------- 3. Build ----------
log "Building TanStack Start production bundle"
"$BUN_BIN" run build
[ -f ".output/server/index.mjs" ] || { echo "❌ Build output missing (.output/server/index.mjs)"; exit 1; }
ok "Build complete"

# ---------- 4. Free port 3001 ----------
log "Ensuring port $PORT is free"
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  warn "Port $PORT is in use — killing occupant(s)"
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  pkill -9 -f "bun run .output/server" 2>/dev/null || true
  pkill -9 -f "node .output/server"    2>/dev/null || true
  sleep 2
fi
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "❌ Port $PORT still in use:"; ss -tlnp | grep ":$PORT "; exit 1
fi
ok "Port $PORT is free"

# ---------- 5. Restart systemd service ----------
log "Restarting $SERVICE"
systemctl daemon-reload
systemctl restart "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" || {
  echo "❌ $SERVICE failed to start. Logs:"
  journalctl -u "$SERVICE" -n 40 --no-pager
  exit 1
}
ok "$SERVICE is active"

# ---------- 6. Reload nginx ----------
log "Testing & reloading nginx"
nginx -t
systemctl reload nginx
ok "nginx reloaded"

# ---------- 7. Smoke test ----------
log "Smoke test"
sleep 1
curl -fsS -o /dev/null -w "  local  :3001  → HTTP %{http_code}\n" "http://127.0.0.1:${PORT}/" || warn "local check failed"
curl -fsS -o /dev/null -w "  public :443   → HTTP %{http_code}\n" -k "https://dashboard.timescard.cloud/" || warn "public check failed"

echo
ok "🚀 Deploy complete — https://dashboard.timescard.cloud"
echo "   Tail logs:  journalctl -u $SERVICE -f"
