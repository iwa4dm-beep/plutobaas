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

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)             REPO="$2"; shift 2;;
    --domain)           DOMAIN="$2"; shift 2;;
    --pluto-url)        PLUTO_URL="$2"; shift 2;;
    --pluto-anon-key)   PLUTO_ANON_KEY="$2"; shift 2;;
    --tenant|--slug)    TENANT="$2"; shift 2;;
    --supabase-db-url)  SUPABASE_DB_URL="$2"; shift 2;;
    --port)             PORT="$2"; shift 2;;
    --app-dir)          APP_DIR="$2"; shift 2;;
    --service)          SERVICE="$2"; shift 2;;
    --primary)          PRIMARY=1; shift;;
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    -*) echo "Unknown flag: $1" >&2; exit 2;;
    *) POSITIONAL+=("$1"); shift;;
  esac
done

die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

# Positional form used by deploy-site-from-github.sh:
#   connect-app-to-pluto.sh <app-dir-or-repo-url> <domain>
if [[ ${#POSITIONAL[@]} -gt 0 ]]; then
  first="${POSITIONAL[0]}"
  if [[ "$first" == http*://* || "$first" == git@* ]]; then
    REPO="$first"
  elif [[ -d "$first" ]]; then
    APP_DIR="${APP_DIR:-$first}"
  fi
  [[ -n "${POSITIONAL[1]:-}" ]] && DOMAIN="${POSITIONAL[1]}"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

# Where the site actually lives. Sites deployed with
# deploy-site-from-github.sh live in /root/sites/<repo>, older primary-app
# installs live in /var/www/<domain>. Auto-detect instead of assuming.
if [[ -z "${APP_DIR:-}" ]]; then
  slug_guess="$(basename "${REPO%.git}" 2>/dev/null || true)"
  for cand in "/root/sites/${slug_guess}" "/var/www/$DOMAIN"; do
    [[ -n "$slug_guess" || "$cand" == /var/www/* ]] || continue
    if [[ -f "$cand/package.json" ]]; then APP_DIR="$cand"; break; fi
  done
  APP_DIR="${APP_DIR:-/var/www/$DOMAIN}"
fi

# If no repo was given but the checkout exists, reuse its origin remote.
if [[ -z "$REPO" && -d "$APP_DIR/.git" ]]; then
  REPO="$(git -C "$APP_DIR" config --get remote.origin.url || true)"
fi

# Service name: match the per-site unit created by deploy-site-from-github.sh.
if [[ -z "${SERVICE:-}" ]]; then
  site_svc="pluto-site-${DOMAIN%%.*}"
  if systemctl list-unit-files "${site_svc}.service" >/dev/null 2>&1 \
     && systemctl cat "$site_svc" >/dev/null 2>&1; then
    SERVICE="$site_svc"
  else
    SERVICE="pluto-app"
  fi
fi
PRIMARY="${PRIMARY:-0}"

[[ -n "$REPO" ]]           || die "--repo is required (or point --app-dir at an existing git checkout)"
[[ -n "$PLUTO_ANON_KEY" ]] || die "--pluto-anon-key is required (VITE_PLUTO_ANON_KEY)"

# Derive tenant slug from repo if not provided
if [[ -z "$TENANT" ]]; then
  TENANT="$(basename "$REPO" .git | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-\+/-/g;s/^-//;s/-$//')"
fi

info "APP_DIR=$APP_DIR  SERVICE=$SERVICE  PRIMARY=$PRIMARY"

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
  if [[ -z "$existing_remote" || "${existing_remote%.git}" != "${REPO%.git}" ]]; then
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
  ( cd "$APP_DIR" && bash "$HERE/migrate-frontend-to-pluto.sh" ) \
    || die "source migration failed; refusing to keep serving the old backend bundle"
else
  die "source dir $APP_DIR is missing package.json"
fi

# ── 3. Rebuild after migration + inject runtime env.js ─────────────────────
info "[3/6] rebuilding with Pluto env baked in"
(
  cd "$APP_DIR"

  # The migration changes package.json. Refresh dependencies before building;
  # otherwise an old node_modules can leave @timescard/pluto-js unresolved.
  if [[ -f bun.lock || -f bun.lockb ]] && command -v bun >/dev/null 2>&1; then
    bun install
  elif [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then
    pnpm install --no-frozen-lockfile
  elif [[ -f yarn.lock ]] && command -v yarn >/dev/null 2>&1; then
    yarn install
  else
    npm install --no-audit --no-fund
  fi

  # Never allow a failed build to fall back to a stale Supabase dist directory.
  rm -rf dist .output build out
  VITE_PLUTO_URL="$PLUTO_URL" \
  VITE_PLUTO_ANON_KEY="$PLUTO_ANON_KEY" \
  NEXT_PUBLIC_PLUTO_URL="$PLUTO_URL" \
  NEXT_PUBLIC_PLUTO_ANON_KEY="$PLUTO_ANON_KEY" \
  PLUTO_URL="$PLUTO_URL" \
  PLUTO_ANON_KEY="$PLUTO_ANON_KEY" \
    npm run build
) || die "Pluto frontend dependency install/build failed; stale build was removed"

DIST=""
for d in "$APP_DIR/dist" "$APP_DIR/.output/public" "$APP_DIR/build" "$APP_DIR/out"; do
  [[ -f "$d/index.html" ]] && { DIST="$d"; break; }
done
if [[ -n "$DIST" ]]; then
  info "injecting env.js into $DIST"
  VITE_PLUTO_URL="$PLUTO_URL" VITE_PLUTO_ANON_KEY="$PLUTO_ANON_KEY" \
    bash "$HERE/inject-pluto-env.sh" "$DIST" \
    || die "runtime Pluto env injection failed"

  # Block activation when any compiled asset still points to the previous BaaS.
  SERVER_OUTPUT=""
  [[ -d "$APP_DIR/.output/server" ]] && SERVER_OUTPUT="$APP_DIR/.output/server"
  bash "$HERE/assert-no-supabase.sh" "$DIST" ${SERVER_OUTPUT:+"$SERVER_OUTPUT"} \
    || die "compiled bundle still contains Supabase references; activation cancelled"

  # Nginx must be able to traverse the checkout and read the newly rebuilt files.
  chown -R root:www-data "$DIST" 2>/dev/null || true
  find "$DIST" -type d -exec chmod 755 {} +
  find "$DIST" -type f -exec chmod 644 {} +
  p="$APP_DIR"
  while [[ "$p" != "/" ]]; do chmod o+x "$p" 2>/dev/null || true; p="$(dirname "$p")"; done

  info "refreshing service and Nginx from the verified post-migration build"
  REPO_URL="$REPO" DOMAIN="$DOMAIN" APP_DIR="$APP_DIR" SERVICE="$SERVICE" PORT="$PORT" \
    SKIP_SOURCE_UPDATE=1 SKIP_BUILD=1 \
    bash "$HERE/install-dashboard-from-github.sh" \
    || die "failed to activate the verified post-migration build"
else
  die "build completed but no deployable index.html was found"
fi

# ── 4. Migrate Supabase schema → Pluto tenant DB (optional) ─────────────────
if [[ -n "$SUPABASE_DB_URL" ]]; then
  info "[4/6] extracting Supabase schema for tenant '$TENANT'"
  bash "$HERE/extract-supabase-schema.sh" "$SUPABASE_DB_URL" "$TENANT" \
    || die "schema extraction failed; database cutover was not completed"

  BUNDLE_DIR="/tmp/pluto-migrations/$TENANT"
  if [[ -f "$BUNDLE_DIR/0001_schema.sql" ]]; then
    if [[ -n "${DATABASE_URL:-}" ]]; then
      info "applying $BUNDLE_DIR/*.sql into Pluto DB"
      for f in "$BUNDLE_DIR"/*.sql; do
        info "  psql < $(basename "$f")"
        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" \
          || die "database migration failed while applying $f"
      done
    else
      die "DATABASE_URL is required when --supabase-db-url is used; schema was extracted but not applied"
    fi
  fi
else
  info "[4/6] no --supabase-db-url given → skipping schema migration"
fi

# ── 5. Restart + set as primary frontend ────────────────────────────────────
info "[5/6] restarting $SERVICE${PRIMARY:+ }"
if systemctl cat "$SERVICE" >/dev/null 2>&1; then
  systemctl restart "$SERVICE" || die "failed to restart $SERVICE"
else
  info "$SERVICE is not installed; treating this as a static SPA deployment"
fi
if [[ "$PRIMARY" == "1" && -f "$HERE/set-primary-frontend.sh" ]]; then
  info "activating $DOMAIN as primary frontend"
  SLUG="$TENANT" DOMAIN="$DOMAIN" bash "$HERE/set-primary-frontend.sh" || warn "set-primary-frontend.sh failed"
else
  info "leaving nginx vhost as-is (pass --primary to make $DOMAIN the primary frontend)"
fi
nginx -t || die "nginx configuration is invalid"
systemctl reload nginx || die "nginx reload failed"

# ── 6. Verify cutover ───────────────────────────────────────────────────────
info "[6/6] verifying the exact local vhost for https://$DOMAIN"
PLUTO_VERIFY_IP="${PLUTO_VERIFY_IP:-127.0.0.1}" \
  bash "$HERE/verify-pluto-cutover.sh" "$DOMAIN" \
  || die "cutover verification failed; deployment is NOT complete"

pass "connect-app-to-pluto.sh done — https://$DOMAIN is now on Pluto BaaS"
