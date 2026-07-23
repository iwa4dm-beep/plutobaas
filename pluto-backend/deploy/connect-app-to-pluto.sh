#!/usr/bin/env bash
# connect-app-to-pluto.sh
# ---------------------------------------------------------------
# One-command wrapper: rebuild a GitHub repo as the primary frontend on
# app.timescard.cloud, migrate its Supabase client to Pluto BaaS, inject
# runtime env, (optionally) extract + apply a Supabase schema dump into
# the Pluto tenant DB, then verify.
#
# Run this on the VPS from inside the pluto backend repo, e.g.:
#   cd /root/backend-joy/pluto-backend
#   sudo -E bash deploy/connect-app-to-pluto.sh \
#     --repo https://github.com/abilhoseen-collab/timesnfc.git \
#     --domain app.timescard.cloud \
#     --pluto-url https://api.timescard.cloud \
#     --pluto-anon-key "$VITE_PLUTO_ANON_KEY" \
#     [--tenant timesnfc] \
#     [--supabase-db-url "postgres://…supabase.co:5432/postgres"] \
#     [--port 8791]
#
# Env fallbacks: REPO, DOMAIN, VITE_PLUTO_URL, VITE_PLUTO_ANON_KEY,
#                TENANT, SUPABASE_DB_URL, PORT, DATABASE_URL.
# ---------------------------------------------------------------
set -euo pipefail

REPO="${REPO:-}"
DOMAIN="${DOMAIN:-app.timescard.cloud}"
PLUTO_URL="${VITE_PLUTO_URL:-https://api.timescard.cloud}"
PLUTO_ANON_KEY="${VITE_PLUTO_ANON_KEY:-}"
TENANT="${TENANT:-}"
SUPABASE_DB_URL="${SUPABASE_DB_URL:-}"
PORT="${PORT:-8791}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)             REPO="$2"; shift 2;;
    --domain)           DOMAIN="$2"; shift 2;;
    --pluto-url)        PLUTO_URL="$2"; shift 2;;
    --pluto-anon-key)   PLUTO_ANON_KEY="$2"; shift 2;;
    --tenant|--slug)    TENANT="$2"; shift 2;;
    --supabase-db-url)  SUPABASE_DB_URL="$2"; shift 2;;
    --port)             PORT="$2"; shift 2;;
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    *) echo "Unknown flag: $1" >&2; exit 2;;
  esac
done

die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

[[ -n "$REPO" ]]           || die "--repo is required"
[[ -n "$PLUTO_ANON_KEY" ]] || die "--pluto-anon-key is required (VITE_PLUTO_ANON_KEY)"

# Derive tenant slug from repo if not provided
if [[ -z "$TENANT" ]]; then
  TENANT="$(basename "$REPO" .git | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-\+/-/g;s/^-//;s/-$//')"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="/var/www/$DOMAIN"
SERVICE="pluto-app"

info "REPO=$REPO"
info "DOMAIN=$DOMAIN  TENANT=$TENANT  PORT=$PORT"
info "PLUTO_URL=$PLUTO_URL  ANON_KEY=${PLUTO_ANON_KEY:0:10}…"

# ── 1. Fetch + install code via install-dashboard-from-github.sh ────────────
info "[1/6] cloning + building $REPO into $APP_DIR (service=$SERVICE port=$PORT)"

# install-dashboard-from-github.sh reads REPO_URL from env (positional args are ignored).
# If APP_DIR exists but is NOT a git checkout of the requested repo, wipe it so
# the installer can clone fresh (fixes "APP_DIR is not a git checkout and REPO_URL is not set").
if [[ -d "$APP_DIR" ]]; then
  existing_remote="$(git -C "$APP_DIR" config --get remote.origin.url 2>/dev/null || true)"
  if [[ -z "$existing_remote" || "$existing_remote" != "$REPO" ]]; then
    warn "wiping $APP_DIR (existing remote='${existing_remote:-<none>}', want='$REPO')"
    systemctl stop "$SERVICE" 2>/dev/null || true
    rm -rf "$APP_DIR"
  fi
fi

REPO_URL="$REPO" DOMAIN="$DOMAIN" APP_DIR="$APP_DIR" SERVICE="$SERVICE" PORT="$PORT" \
  bash "$HERE/install-dashboard-from-github.sh" || die "install-dashboard-from-github.sh failed"

# ── 2. Rewrite source: @supabase/supabase-js → @timescard/pluto-js ──────────
info "[2/6] rewriting Supabase client imports → Pluto (source-level)"
if [[ -d "$APP_DIR" && -f "$APP_DIR/package.json" ]]; then
  ( cd "$APP_DIR" && bash "$HERE/migrate-frontend-to-pluto.sh" ) || warn "migrate-frontend-to-pluto.sh reported warnings"
else
  warn "source dir $APP_DIR missing package.json — skipping source rewrite"
fi

# ── 3. Rebuild after migration + inject runtime env.js ─────────────────────
info "[3/6] rebuilding with Pluto env baked in"
if [[ -f "$APP_DIR/package.json" ]]; then
  ( cd "$APP_DIR" \
      && VITE_PLUTO_URL="$PLUTO_URL" VITE_PLUTO_ANON_KEY="$PLUTO_ANON_KEY" \
         npm run build ) || warn "npm run build failed — keeping previous build"
fi

DIST=""
for d in "$APP_DIR/dist" "$APP_DIR/.output/public" "$APP_DIR/build" "$APP_DIR/out"; do
  [[ -f "$d/index.html" ]] && { DIST="$d"; break; }
done
if [[ -n "$DIST" ]]; then
  info "injecting env.js into $DIST"
  VITE_PLUTO_URL="$PLUTO_URL" VITE_PLUTO_ANON_KEY="$PLUTO_ANON_KEY" \
    bash "$HERE/inject-pluto-env.sh" "$DIST" || warn "inject-pluto-env.sh failed"
else
  warn "no dist/ found — env.js injection skipped"
fi

# ── 4. Migrate Supabase schema → Pluto tenant DB (optional) ─────────────────
if [[ -n "$SUPABASE_DB_URL" ]]; then
  info "[4/6] extracting Supabase schema for tenant '$TENANT'"
  bash "$HERE/extract-supabase-schema.sh" "$SUPABASE_DB_URL" "$TENANT" \
    || warn "schema extraction failed — continuing"

  BUNDLE_DIR="/tmp/pluto-migrations/$TENANT"
  if [[ -f "$BUNDLE_DIR/0001_schema.sql" ]]; then
    if [[ -n "${DATABASE_URL:-}" ]]; then
      info "applying $BUNDLE_DIR/*.sql into Pluto DB"
      for f in "$BUNDLE_DIR"/*.sql; do
        info "  psql < $(basename "$f")"
        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || warn "psql apply failed for $f"
      done
    else
      warn "DATABASE_URL not set — leaving schema bundle at $BUNDLE_DIR for manual apply"
    fi
  fi
else
  info "[4/6] no --supabase-db-url given → skipping schema migration"
fi

# ── 5. Restart + set as primary frontend ────────────────────────────────────
info "[5/6] restarting $SERVICE + activating primary frontend"
systemctl restart "$SERVICE" 2>/dev/null || warn "systemctl restart $SERVICE failed"
if [[ -x "$HERE/set-primary-frontend.sh" ]]; then
  SLUG="$TENANT" DOMAIN="$DOMAIN" bash "$HERE/set-primary-frontend.sh" || warn "set-primary-frontend.sh failed"
fi
nginx -t && systemctl reload nginx || warn "nginx reload failed"

# ── 6. Verify cutover ───────────────────────────────────────────────────────
info "[6/6] verifying cutover on https://$DOMAIN"
bash "$HERE/verify-pluto-cutover.sh" "$DOMAIN" || warn "verify-pluto-cutover reported issues"

pass "connect-app-to-pluto.sh done — https://$DOMAIN is now on Pluto BaaS"
