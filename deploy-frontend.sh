#!/usr/bin/env bash
# ============================================================
# Pluto BaaS — Frontend Deploy Script (VPS)
# Usage:  sudo APP_DIR=/root/backend-joy bash /root/backend-joy/deploy-frontend.sh
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/root/backend-joy}"
SERVICE="${SERVICE:-pluto-dashboard}"
PORT="${PORT:-3001}"
PUBLIC_URL="${PUBLIC_URL:-https://dashboard.timescard.cloud/}"
BUN_BIN="${BUN_BIN:-/root/.bun/bin/bun}"

log() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }
fail(){ printf "\033[1;31m❌ %s\033[0m\n" "$*"; exit 1; }

# ---------- 0. Sanity ----------
[ -d "$APP_DIR" ] || fail "$APP_DIR not found"
cd "$APP_DIR"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$APP_DIR is not a git repository"

if [ ! -x "$BUN_BIN" ]; then
  warn "bun not found at $BUN_BIN — installing"
  curl -fsSL https://bun.sh/install | bash
  export PATH="/root/.bun/bin:$PATH"
  BUN_BIN="/root/.bun/bin/bun"
fi

# ---------- 1. Pull latest/full tree ----------
log "Pulling FULL latest project from GitHub"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --all --tags --prune

# VPS-এ হাতে edit করা tracked files build-কে stale করে রাখলে এগুলো stash হবে।
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "Local tracked changes found — stashing before reset"
  git stash push -u -m "vps-frontend-auto-stash-$(date +%Y%m%d-%H%M%S)" || true
fi

git reset --hard "origin/${CURRENT_BRANCH}"
# untracked stale source files remove, কিন্তু env/runtime files safe রাখে
git clean -fd \
  -e .env -e .env.local -e .env.production \
  -e pluto-backend/.env -e backend/.env \
  -e uploads -e storage || true

NEW_SHA="$(git rev-parse --short HEAD)"
ok "Repo fully synced: ${CURRENT_BRANCH} @ ${NEW_SHA}"

# ---------- 1.1 Critical dashboard files ----------
log "Verifying Auth & Users dashboard files"
[ -f src/routes/dashboard.users.tsx ] || fail "src/routes/dashboard.users.tsx missing — GitHub branch does not contain Auth & Users page"
[ -f src/components/pluto/Sidebar.tsx ] || fail "src/components/pluto/Sidebar.tsx missing"
grep -q 'Auth & Users' src/routes/dashboard.users.tsx || fail "Auth & Users page content is not present in pulled code"
grep -q '/dashboard/users' src/components/pluto/Sidebar.tsx || fail "Sidebar route /dashboard/users is not present"
ok "Auth & Users files are present in this checkout"

# ---------- 2. Install deps ----------
log "Installing dependencies (bun install)"
"$BUN_BIN" install --frozen-lockfile || "$BUN_BIN" install
ok "Dependencies installed"

# ---------- 3. Build ----------
log "Building TanStack Start production bundle"
rm -rf .output .vinxi .tanstack 2>/dev/null || true
"$BUN_BIN" run build
[ -f ".output/server/index.mjs" ] || fail "Build output missing (.output/server/index.mjs)"
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
curl -fsS -o /dev/null -w "  users  :3001  → HTTP %{http_code}\n" "http://127.0.0.1:${PORT}/dashboard/users" || warn "local /dashboard/users check failed"
curl -fsS -o /dev/null -w "  public :443   → HTTP %{http_code}\n" -k "$PUBLIC_URL" || warn "public check failed"

echo
ok "🚀 Deploy complete — ${PUBLIC_URL}  (${NEW_SHA})"
echo "   Tail logs:  journalctl -u $SERVICE -f"
