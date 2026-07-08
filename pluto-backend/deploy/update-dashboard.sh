#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update-dashboard.sh
#   VPS-এ Pluto backend + dashboard/frontend কে GitHub-এর latest code দিয়ে refresh করে।
#   Usage:  bash deploy/update-dashboard.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# pluto-backend root (script যেখানেই থাকুক)
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
COMPOSE="docker compose --env-file .env -f docker/docker-compose.yml"

log()  { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m⚠ %s\033[0m\n" "$*"; }
fail() { printf "\033[1;31m✘ %s\033[0m\n" "$*"; exit 1; }

# ---------------------------------------------------------------------------
# 1. Pre-flight
# ---------------------------------------------------------------------------
log "Pre-flight checks"
command -v git    >/dev/null || fail "git missing"
command -v docker >/dev/null || fail "docker missing"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin missing"
[ -f .env ] || fail ".env file not found at $REPO_ROOT/.env"
ok "environment OK  (repo: $REPO_ROOT)"

# ---------------------------------------------------------------------------
# 2. GitHub থেকে latest code
# ---------------------------------------------------------------------------
log "Pulling full latest project from GitHub"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --all --prune
# local dirty change থাকলে stash (data loss হবে না)
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "Local changes detected — stashing as 'auto-stash-$(date +%s)'"
  git stash push -u -m "auto-stash-$(date +%s)" || true
fi
git reset --hard "origin/${CURRENT_BRANCH}"
git clean -fd \
  -e .env -e .env.local -e .env.production \
  -e backend/.env -e pluto-backend/.env \
  -e uploads -e storage || true
NEW_SHA="$(git rev-parse --short HEAD)"
ok "checked out ${CURRENT_BRANCH} @ ${NEW_SHA}"

log "Verifying Auth & Users dashboard files in Git checkout"
if [ -f "$GIT_ROOT/src/routes/dashboard.users.tsx" ] && [ -f "$GIT_ROOT/src/components/pluto/Sidebar.tsx" ]; then
  grep -q 'Auth & Users' "$GIT_ROOT/src/routes/dashboard.users.tsx" \
    && grep -q '/dashboard/users' "$GIT_ROOT/src/components/pluto/Sidebar.tsx" \
    && ok "Auth & Users dashboard source is present" \
    || warn "Auth & Users source exists but expected text/route was not found"
else
  warn "Frontend dashboard source not found beside pluto-backend; run the frontend deploy script from the full project repo"
fi

# ---------------------------------------------------------------------------
# 3. Role verification (adminসহ সব role আছে কিনা)
# ---------------------------------------------------------------------------
if [ -x deploy/verify-pg-roles.sh ]; then
  log "Verifying Postgres roles"
  bash deploy/verify-pg-roles.sh || warn "role verify returned non-zero (continuing)"
fi

# ---------------------------------------------------------------------------
# 4. Migration (নতুন migration থাকলে apply)
# ---------------------------------------------------------------------------
if [ -x deploy/run-migrator.sh ]; then
  log "Running migrations"
  bash deploy/run-migrator.sh || fail "migration failed"
  ok "migrations applied"
fi

# ---------------------------------------------------------------------------
# 5. Backend rebuild (API + worker + যা যা আছে)
# ---------------------------------------------------------------------------
log "Rebuilding backend containers (no-cache)"
$COMPOSE build --no-cache
ok "images built"

log "Recreating containers"
$COMPOSE up -d --force-recreate --remove-orphans
ok "containers up"

# ---------------------------------------------------------------------------
# 6. Health + endpoint verification
# ---------------------------------------------------------------------------
log "Waiting for API to become healthy"
API_URL="http://127.0.0.1:3000"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/health" || echo 000)"
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then
    ok "API responding (HTTP $code) after ${i}s"
    break
  fi
  sleep 1
  [ "$i" = "30" ] && fail "API did not respond within 30s"
done

log "Verifying critical endpoints"
check_ep() {
  local path="$1" expect="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL$path" || echo 000)"
  if [ "$code" = "$expect" ]; then
    ok "$path → HTTP $code"
  else
    warn "$path → HTTP $code (expected $expect)"
  fi
}
check_ep "/admissions/v1/search?q=ab" 401
check_ep "/openapi.json"              200

if curl -s "$API_URL/openapi.json" | grep -q '"/admissions/v1/search"'; then
  ok "search route registered in OpenAPI"
else
  warn "search route NOT in OpenAPI — build may be stale"
fi

# ---------------------------------------------------------------------------
# 7. Cleanup dangling images
# ---------------------------------------------------------------------------
log "Pruning dangling images"
docker image prune -f >/dev/null || true
ok "cleanup done"

# ---------------------------------------------------------------------------
# 8. Optional frontend/dashboard deploy (Auth & Users page)
# ---------------------------------------------------------------------------
if [ -f "$GIT_ROOT/deploy-frontend.sh" ]; then
  log "Deploying VPS dashboard frontend (Auth & Users page)"
  APP_DIR="$GIT_ROOT" bash "$GIT_ROOT/deploy-frontend.sh" || warn "frontend deploy failed — run: APP_DIR=$GIT_ROOT bash $GIT_ROOT/deploy-frontend.sh"
else
  warn "deploy-frontend.sh not found at $GIT_ROOT — backend updated only"
fi

# ---------------------------------------------------------------------------
# 9. Summary
# ---------------------------------------------------------------------------
echo
echo "───────────────────────────────────────────────"
ok  "Dashboard/backend updated to ${NEW_SHA}"
echo "───────────────────────────────────────────────"
echo "Next steps:"
echo "  • VPS dashboard: open /dashboard/users and hard-refresh (Ctrl+F5)"
echo "  • Lovable hosted dashboard: click Publish → Update if you use backend-joy.lovable.app"
echo "  • Verify via nginx:  curl -s -o /dev/null -w '%{http_code}\\n' \\"
echo "      https://YOUR-DOMAIN/api/pluto/admissions/v1/search?q=ab"
echo "───────────────────────────────────────────────"
