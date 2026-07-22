#!/usr/bin/env bash
# build-and-cutover.sh
# ---------------------------------------------------------------
# One-command frontend build + Pluto cutover for a project on the VPS.
#
# Steps:
#   1. cd into the project directory (arg or $PWD)
#   2. Ensure dependencies installed (bun install if lockfile changed / node_modules missing)
#   3. Run the project's build command (auto-detected: package.json "build"
#      script, else `bunx vite build`, else `npx vite build`)
#   4. Inject dist/env.js with VITE_PLUTO_URL / VITE_PLUTO_ANON_KEY
#   5. Fail if dist/ still contains supabase.co references
#   6. (optional) Deploy dist as a ZIP to the primary frontend
#   7. Run smoke-cutover.sh against dist/ (and the live URL if deployed)
#
# Usage (from anywhere):
#   sudo VITE_PLUTO_URL=https://api.timescard.cloud \
#        VITE_PLUTO_ANON_KEY=pk_anon_xxx \
#        SLUG=timesn \
#        SITE_URL=https://app.timescard.cloud \
#        bash /opt/pluto/deploy/build-and-cutover.sh /root/timesn
#
# Env:
#   VITE_PLUTO_URL       (required) e.g. https://api.timescard.cloud
#   VITE_PLUTO_ANON_KEY  (required) pk_anon_...
#   SLUG                 (optional) if set, ZIP dist/ and deploy to primary
#   SITE_URL             (optional) URL for the live smoke test
#   SKIP_INSTALL=1       skip `bun install`
#   SKIP_BUILD=1         reuse existing dist/
#   SKIP_DEPLOY=1        build + verify only, don't deploy
# ---------------------------------------------------------------
set -euo pipefail

PROJECT_DIR="${1:-$PWD}"
DEPLOY_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -d "$PROJECT_DIR" ]] || die "project dir not found: $PROJECT_DIR"
cd "$PROJECT_DIR"
[[ -f package.json ]] || die "no package.json in $PROJECT_DIR"

: "${VITE_PLUTO_URL:?VITE_PLUTO_URL is required (e.g. https://api.timescard.cloud)}"
: "${VITE_PLUTO_ANON_KEY:?VITE_PLUTO_ANON_KEY is required (pk_anon_...)}"
[[ "$VITE_PLUTO_ANON_KEY" != "pk_anon_REPLACE_ME" ]] || die "VITE_PLUTO_ANON_KEY is still the placeholder pk_anon_REPLACE_ME"

export VITE_PLUTO_URL VITE_PLUTO_ANON_KEY

# --- pick a package manager ------------------------------------
if command -v bun >/dev/null 2>&1; then PM=bun
elif command -v pnpm >/dev/null 2>&1; then PM=pnpm
elif command -v npm >/dev/null 2>&1; then PM=npm
else die "need bun, pnpm, or npm on PATH"; fi
log "package manager: $PM"

# --- install ---------------------------------------------------
if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  if [[ ! -d node_modules ]]; then
    log "installing dependencies ($PM install)"
    case "$PM" in
      bun)  bun install ;;
      pnpm) pnpm install ;;
      npm)  npm install ;;
    esac
  else
    pass "node_modules present — skipping install (SKIP_INSTALL=1 to force)"
  fi
fi

# --- detect build script --------------------------------------
detect_build_cmd() {
  # 1) explicit "build" script in package.json
  if node -e 'process.exit(!(require("./package.json").scripts||{}).build)' 2>/dev/null; then
    case "$PM" in
      bun)  echo "bun run build" ;;
      pnpm) echo "pnpm run build" ;;
      npm)  echo "npm run build" ;;
    esac
    return
  fi
  # 2) vite project with no "build" script — call vite directly
  if [[ -f vite.config.ts || -f vite.config.js || -f vite.config.mjs ]]; then
    case "$PM" in
      bun)  echo "bunx vite build" ;;
      pnpm) echo "pnpm exec vite build" ;;
      npm)  echo "npx vite build" ;;
    esac
    return
  fi
  # 3) next
  if [[ -f next.config.js || -f next.config.mjs ]]; then
    case "$PM" in
      bun)  echo "bunx next build" ;;
      pnpm) echo "pnpm exec next build" ;;
      npm)  echo "npx next build" ;;
    esac
    return
  fi
  echo ""
}

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  BUILD_CMD="$(detect_build_cmd)"
  [[ -n "$BUILD_CMD" ]] || die "cannot detect a build command — add a \"build\" script to package.json"
  log "building: $BUILD_CMD"
  # shellcheck disable=SC2086
  eval "$BUILD_CMD"
else
  warn "SKIP_BUILD=1 — reusing existing dist/"
fi

# --- locate dist ----------------------------------------------
DIST=""
for cand in dist build out .output/public public; do
  if [[ -f "$cand/index.html" ]]; then DIST="$cand"; break; fi
done
[[ -n "$DIST" ]] || die "no built index.html found (looked in dist/ build/ out/ .output/public/ public/)"
pass "dist: $DIST"

# --- inject env.js --------------------------------------------
log "injecting $DIST/env.js"
bash "$DEPLOY_DIR/inject-pluto-env.sh" "$DIST"

# --- guard against supabase leftovers -------------------------
log "asserting no Supabase references in $DIST"
bash "$DEPLOY_DIR/assert-no-supabase.sh" "$DIST"

# --- optional deploy to primary -------------------------------
if [[ -n "${SLUG:-}" && "${SKIP_DEPLOY:-0}" != "1" ]]; then
  ZIP="/tmp/${SLUG}-$(date -u +%Y%m%dT%H%M%SZ).zip"
  log "zipping $DIST → $ZIP"
  ( cd "$DIST" && zip -qr "$ZIP" . )
  log "deploying $ZIP to primary frontend (slug=$SLUG)"
  sudo -E PLUTO_URL="$VITE_PLUTO_URL" PLUTO_ANON_KEY="$VITE_PLUTO_ANON_KEY" \
    bash "$DEPLOY_DIR/deploy-local-zip-to-primary.sh" "$SLUG" "$ZIP"
fi

# --- smoke test -----------------------------------------------
log "smoke cutover test"
SMOKE_ARGS=(--dist "$DIST")
[[ -n "${SITE_URL:-}" ]] && SMOKE_ARGS+=(--url "$SITE_URL")
bash "$DEPLOY_DIR/smoke-cutover.sh" "${SMOKE_ARGS[@]}"

pass "build-and-cutover finished"
