#!/usr/bin/env bash
# ==============================================================================
#  Pluto BaaS · VPS one-shot bootstrap
# ==============================================================================
#  আপনার VPS-এ git / psql / pnpm / node কিছুই নেই — এই script সব install
#  করে, তারপর সব pending migration (0015 + Phase 15 batch 0016–0026) apply
#  করে, backend rebuild করে, service restart করে।
#
#  ব্যবহার:
#    cd ~/backend-joy/pluto-backend
#    chmod +x deploy/bootstrap-vps.sh
#    sudo ./deploy/bootstrap-vps.sh
#
#  Flags:
#    --skip-install     prerequisite install skip করবে
#    --skip-build       pnpm build skip করবে
#    --skip-restart     systemctl restart skip করবে
#    --db "postgres://…"  DATABASE_URL override
# ==============================================================================
set -euo pipefail

SKIP_INSTALL=0; SKIP_BUILD=0; SKIP_RESTART=0; DB_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --db)           DB_OVERRIDE="$2"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()  { printf "  \033[1;32m✔\033[0m %s\n" "$*"; }
err() { printf "  \033[1;31m✖\033[0m %s\n" "$*" >&2; }

# ---------- 1. Prerequisites ----------
if [[ $SKIP_INSTALL -eq 0 ]]; then
  log "Installing prerequisites (git, psql, curl, node, pnpm)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg postgresql-client-common postgresql-client
  ok "git + psql installed"

  if ! command -v node >/dev/null || [[ "$(node -v 2>/dev/null | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
    log "Installing Node.js 20.x (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  ok "node $(node -v)"

  if ! command -v pnpm >/dev/null; then
    log "Installing pnpm"
    npm install -g pnpm@9
  fi
  ok "pnpm $(pnpm -v)"
else
  ok "skipping prerequisite install"
fi

# ---------- 2. Load DATABASE_URL ----------
if [[ -n "$DB_OVERRIDE" ]]; then
  export DATABASE_URL="$DB_OVERRIDE"
fi
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  set -a; . ./.env; set +a
fi
if [[ -z "${DATABASE_URL:-}" || "$DATABASE_URL" == *"…"* ]]; then
  err "DATABASE_URL not set (or still contains the placeholder …)"
  echo "   Fix: export DATABASE_URL='postgres://user:pass@host:5432/db'"
  echo "   অথবা: $0 --db 'postgres://…'"
  exit 1
fi
log "Using DB: ${DATABASE_URL%%\?*}"

# ---------- 3. Sanity: DB reachable ----------
log "Probing database"
if ! psql "$DATABASE_URL" -Atc "select 1" >/dev/null; then
  err "psql cannot connect to \$DATABASE_URL"; exit 1
fi
ok "database reachable"

# ---------- 4. Backup ----------
BACKUP_DIR="$REPO_ROOT/backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/pre-bootstrap-$(date +%Y%m%d-%H%M%S).sql.gz"
log "Schema backup → $BACKUP_FILE"
if pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges 2>/dev/null | gzip > "$BACKUP_FILE"; then
  ok "backup $(du -h "$BACKUP_FILE" | cut -f1)"
else
  err "pg_dump failed — continuing without backup"
  rm -f "$BACKUP_FILE"
fi

# ---------- 5. Apply migrations ----------
log "Applying migrations from $REPO_ROOT/migrations"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "create table if not exists _pluto_migrations(name text primary key, applied_at timestamptz default now())" \
  >/dev/null

shopt -s nullglob
for f in migrations/*.sql; do
  name="$(basename "$f")"
  already=$(psql "$DATABASE_URL" -Atc "select 1 from _pluto_migrations where name = '$name'")
  if [[ "$already" == "1" ]]; then
    printf "  ✓ %s (already applied)\n" "$name"
    continue
  fi
  printf "  → %s\n" "$name"
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
      "insert into _pluto_migrations(name) values ('$name') on conflict do nothing" >/dev/null
    ok "applied $name"
  else
    err "FAILED on $name — aborting"; exit 1
  fi
done

# ---------- 6. Verify Phase 15 batch ----------
log "Verifying 0015 + Phase 15 batch (0015–0026)"
psql "$DATABASE_URL" -Atc "
  select name from _pluto_migrations
  where name ~ '^00(15|1[6-9]|2[0-6])_'
  order by name"

# ---------- 7. Build ----------
if [[ $SKIP_BUILD -eq 0 ]]; then
  log "Installing deps + building @pluto/api"
  if [[ -f pnpm-workspace.yaml ]]; then
    pnpm install --frozen-lockfile || pnpm install
    pnpm --filter @pluto/api build
  else
    err "pnpm-workspace.yaml missing — skipping build"
  fi
  ok "build complete"
else
  ok "skipping build"
fi

# ---------- 8. Restart service ----------
if [[ $SKIP_RESTART -eq 0 ]]; then
  if systemctl list-unit-files pluto-backend.service >/dev/null 2>&1; then
    log "Restarting pluto-backend.service"
    systemctl restart pluto-backend.service
    sleep 2
    systemctl status pluto-backend.service --no-pager -l | head -12 || true
  else
    err "pluto-backend.service unit not found — start manually"
  fi
else
  ok "skipping restart"
fi

# ---------- 9. Health probe ----------
log "Health probe"
HOST="${PLUTO_HEALTH_URL:-http://127.0.0.1:3000}"
for path in /livez /readyz /health/migrations; do
  printf "  %s → " "$path"
  curl -fsS --max-time 5 "$HOST$path" | head -c 200 || echo "(failed)"
  echo
done

echo
ok "Bootstrap complete. Dashboard refresh করে দেখুন — সব page এ data আসবে।"
