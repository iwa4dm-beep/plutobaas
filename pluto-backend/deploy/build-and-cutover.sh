#!/usr/bin/env bash
# build-and-cutover.sh
# ---------------------------------------------------------------
# One-command frontend build + Pluto cutover for a project on the VPS.
#
# Steps:
#   1. cd into project dir (arg or $PWD)
#   2. Install deps (unless SKIP_INSTALL=1)
#   3. Build (unless SKIP_BUILD=1)
#   4. Inject dist/env.js with VITE_PLUTO_URL / VITE_PLUTO_ANON_KEY
#   5. Guard: no supabase.co leftovers in dist/
#   6. Backup previous release (for --rollback)
#   7. (optional) ZIP dist and deploy to primary
#   8. Restart systemd unit (SYSTEMD_UNIT) and tail journalctl
#   9. Smoke test dist + live URL
#
# Flags:
#   --dry-run    Print commands + files that would change; no deploy/restart.
#   --rollback   Restore the most recent backup (or BACKUP_ID=<name>) and skip build.
#   --backup-id <file|path>  Restore a specific backup with --rollback.
#
# Env:
#   VITE_PLUTO_URL, VITE_PLUTO_ANON_KEY  (required, except --rollback)
#   SLUG                (optional) if set, ZIP+deploy to primary
#   SITE_URL            (optional) URL for live smoke test
#   SYSTEMD_UNIT        (optional) e.g. pluto-sandbox-worker.service — restarted + tailed
#   SKIP_INSTALL/BUILD/DEPLOY=1
#   PLUTO_PROFILE=prod
#   REQUIRE_AUTH_SMOKE=1
#   BACKUP_DIR=/var/lib/pluto/backups
#   BACKUP_KEEP=5       how many backups to retain
# ---------------------------------------------------------------
set -euo pipefail

# ---- args -----------------------------------------------------
DRY_RUN=0
ROLLBACK=0
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  a="$1"
  case "$a" in
    --dry-run)  DRY_RUN=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --backup-id) BACKUP_ID="${2:-}"; shift 2 ;;
    --backup-id=*) BACKUP_ID="${a#*=}"; shift ;;
    -h|--help)
      sed -n '2,36p' "$0"; exit 0 ;;
    *) POSITIONAL+=("$a"); shift ;;
  esac
done
set -- "${POSITIONAL[@]:-}"

PROJECT_DIR="${1:-$PWD}"
DEPLOY_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/pluto/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-5}"
LAST_BACKUP=""
DEPLOYED_THIS_RUN=0

validate_pluto_key() {
  local key="${1:-}"
  case "$key" in
    ""|pk_anon_REPLACE_ME|REPLACE_ME|CHANGE_ME|YOUR_KEY|YOUR_ANON_KEY|*...*|*…*)
      return 1
      ;;
  esac
  return 0
}

# Backward-compat safety for stale copied wrappers or accidental positional flags.
if [[ "$PROJECT_DIR" = "--rollback" ]]; then
  ROLLBACK=1
  PROJECT_DIR="$PWD"
fi

# ---- logging --------------------------------------------------
ts()   { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log()  { printf '\n\033[1;36m[%s] ▶ %s\033[0m\n' "$(ts)" "$*"; }
pass() { printf '\033[1;32m[%s] ✓ %s\033[0m\n' "$(ts)" "$*"; }
warn() { printf '\033[1;33m[%s] ! %s\033[0m\n' "$(ts)" "$*"; }
step() { printf '\033[1;35m[%s] ⋯ %s\033[0m\n' "$(ts)" "$*"; }
dry()  { printf '\033[1;90m[%s] (dry-run) %s\033[0m\n' "$(ts)" "$*"; }

FAIL_STAGE=""
die() {
  printf '\n\033[1;31m[%s] ✗ FAIL (%s): %s\033[0m\n' "$(ts)" "${FAIL_STAGE:-unknown}" "$*" >&2
  exit 1
}
stage() { FAIL_STAGE="$1"; step "stage: $1"; }

# run: execute unless --dry-run
run() {
  if [[ $DRY_RUN -eq 1 ]]; then dry "$*"; return 0; fi
  eval "$@"
}

restore_backup_zip() {
  local zip="$1"
  [[ -n "${SLUG:-}" ]] || die "SLUG=<slug> required for rollback"
  [[ -f "$zip" ]] || die "rollback ZIP not found: $zip"
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "PLUTO_ALLOW_SUPABASE_LEFTOVERS=1 PLUTO_SKIP_CUTOVER_VERIFY=1 deploy-local-zip-to-primary.sh $SLUG $zip"
  else
    sudo -E PLUTO_ALLOW_SUPABASE_LEFTOVERS=1 PLUTO_SKIP_CUTOVER_VERIFY=1 \
      bash "$DEPLOY_DIR/deploy-local-zip-to-primary.sh" "$SLUG" "$zip" || die "restore failed"
  fi
}

if [[ $ROLLBACK -eq 0 ]]; then
  [[ -d "$PROJECT_DIR" ]] || { FAIL_STAGE=preflight; die "project dir not found: $PROJECT_DIR"; }
  cd "$PROJECT_DIR"
else
  [[ -d "$PROJECT_DIR" ]] && cd "$PROJECT_DIR" || true
fi

# ---- helper: ensure deploy scripts present --------------------
for f in inject-pluto-env.sh assert-no-supabase.sh smoke-cutover.sh deploy-local-zip-to-primary.sh; do
  [[ -f "$DEPLOY_DIR/$f" ]] || { FAIL_STAGE=preflight; die "missing $DEPLOY_DIR/$f — run: sudo bash pluto-backend/deploy/install-deploy-scripts.sh"; }
done

# =====================================================================
# ROLLBACK MODE
# =====================================================================
if [[ $ROLLBACK -eq 1 ]]; then
  stage rollback
  [[ -n "${SLUG:-}" ]] || die "SLUG=<slug> required for --rollback"
  SLUG_BACKUPS="$BACKUP_DIR/$SLUG"
  [[ -d "$SLUG_BACKUPS" ]] || die "no backups at $SLUG_BACKUPS"
  TARGET="${BACKUP_ID:-}"
  if [[ -z "$TARGET" ]]; then
    TARGET="$(ls -1t "$SLUG_BACKUPS" | head -n1 || true)"
  fi
  if [[ "$TARGET" = /* ]]; then
    ZIP="$TARGET"
  else
    ZIP="$SLUG_BACKUPS/$TARGET"
  fi
  [[ -n "$TARGET" && -f "$ZIP" ]] || die "backup not found (set BACKUP_ID=<file>)"
  log "rolling back $SLUG → $TARGET"
  restore_backup_zip "$ZIP"
  pass "rollback complete: $TARGET"
  # fall through to restart+smoke if configured
else
  # ---- required env ------------------------------------------
  stage preflight
  : "${VITE_PLUTO_URL:?VITE_PLUTO_URL is required (e.g. https://api.timescard.cloud)}"
  : "${VITE_PLUTO_ANON_KEY:?VITE_PLUTO_ANON_KEY is required (pk_anon_...)}"
  validate_pluto_key "$VITE_PLUTO_ANON_KEY" || die "VITE_PLUTO_ANON_KEY is missing or a placeholder. Use the real publishable/anon key, not pk_..."
  export VITE_PLUTO_URL VITE_PLUTO_ANON_KEY
  [[ -f package.json ]] || die "no package.json in $PROJECT_DIR"
  pass "preflight ok (project=$PROJECT_DIR, dry-run=$DRY_RUN)"

  # ---- pick package manager ----------------------------------
  if command -v bun >/dev/null 2>&1; then PM=bun
  elif command -v pnpm >/dev/null 2>&1; then PM=pnpm
  elif command -v npm >/dev/null 2>&1; then PM=npm
  else die "need bun/pnpm/npm"; fi
  log "package manager: $PM"

  # ---- install -----------------------------------------------
  stage install
  if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
    if [[ ! -d node_modules ]]; then
      case "$PM" in
        bun)  run "bun install" ;;
        pnpm) run "pnpm install" ;;
        npm)  run "npm install" ;;
      esac
    else
      pass "node_modules present — skipping"
    fi
  else warn "SKIP_INSTALL=1"; fi

  # ---- build -------------------------------------------------
  stage build
  detect_build_cmd() {
    if node -e 'process.exit(!(require("./package.json").scripts||{}).build)' 2>/dev/null; then
      case "$PM" in bun) echo "bun run build";; pnpm) echo "pnpm run build";; npm) echo "npm run build";; esac; return
    fi
    if [[ -f vite.config.ts || -f vite.config.js || -f vite.config.mjs ]]; then
      case "$PM" in bun) echo "bunx vite build";; pnpm) echo "pnpm exec vite build";; npm) echo "npx vite build";; esac; return
    fi
    if [[ -f next.config.js || -f next.config.mjs ]]; then
      case "$PM" in bun) echo "bunx next build";; pnpm) echo "pnpm exec next build";; npm) echo "npx next build";; esac; return
    fi
    echo ""
  }
  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    BUILD_CMD="$(detect_build_cmd)"
    [[ -n "$BUILD_CMD" ]] || die "cannot detect build command"
    log "build: $BUILD_CMD"
    run "$BUILD_CMD" || die "build command failed"
  else warn "SKIP_BUILD=1"; fi

  # ---- locate dist -------------------------------------------
  stage locate-dist
  DIST=""
  for cand in dist build out .output/public public; do
    [[ -f "$cand/index.html" ]] && { DIST="$cand"; break; }
  done
  [[ -n "$DIST" ]] || die "no built index.html (dist/ build/ out/ .output/public/ public/)"
  pass "dist: $DIST"

  # ---- inject env.js -----------------------------------------
  stage inject-env
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "inject-pluto-env.sh $DIST  → would write $DIST/env.js and patch $DIST/index.html"
  else
    bash "$DEPLOY_DIR/inject-pluto-env.sh" "$DIST" || die "inject-pluto-env.sh failed (check VITE_PLUTO_URL/ANON_KEY are exported)"
  fi

  # ---- supabase guard ----------------------------------------
  stage supabase-guard
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "assert-no-supabase.sh $DIST"
  else
    if ! bash "$DEPLOY_DIR/assert-no-supabase.sh" "$DIST"; then
      die "supabase leftovers found in $DIST — re-run pluto-backend/deploy/migrate-frontend-to-pluto.sh on the source"
    fi
  fi

  # ---- backup previous release + deploy ----------------------
  if [[ -n "${SLUG:-}" && "${SKIP_DEPLOY:-0}" != "1" ]]; then
    stage backup
    SLUG_BACKUPS="$BACKUP_DIR/$SLUG"
    PREV_CURRENT="/var/lib/pluto/sites/$SLUG/current"
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    BACKUP_ZIP="$SLUG_BACKUPS/${SLUG}-${STAMP}.zip"
    if [[ $DRY_RUN -eq 1 ]]; then
      dry "mkdir -p $SLUG_BACKUPS && zip previous release ($PREV_CURRENT) → $BACKUP_ZIP"
    else
      sudo install -d -m 0755 "$SLUG_BACKUPS"
      if [[ -e "$PREV_CURRENT" ]]; then
        REAL_PREV="$(readlink -f "$PREV_CURRENT" || true)"
        if [[ -n "$REAL_PREV" && -d "$REAL_PREV" ]]; then
          ( cd "$REAL_PREV" && sudo zip -qr "$BACKUP_ZIP" . ) && pass "backup: $BACKUP_ZIP" \
            || warn "backup failed (continuing)"
          [[ -f "$BACKUP_ZIP" ]] && LAST_BACKUP="$BACKUP_ZIP"
        else warn "no previous release to backup"; fi
      else warn "no existing $PREV_CURRENT — first deploy, skipping backup"; fi
      # prune
      ls -1t "$SLUG_BACKUPS"/*.zip 2>/dev/null | tail -n +$((BACKUP_KEEP+1)) | xargs -r sudo rm -f || true
    fi

    stage deploy
    ZIP="/tmp/${SLUG}-${STAMP}.zip"
    if [[ $DRY_RUN -eq 1 ]]; then
      dry "zip $DIST → $ZIP && deploy-local-zip-to-primary.sh $SLUG $ZIP"
    else
      ( cd "$DIST" && zip -qr "$ZIP" . )
      if ! sudo -E PLUTO_URL="$VITE_PLUTO_URL" PLUTO_ANON_KEY="$VITE_PLUTO_ANON_KEY" \
            bash "$DEPLOY_DIR/deploy-local-zip-to-primary.sh" "$SLUG" "$ZIP"; then
        warn "deploy failed — attempting auto-rollback"
        if [[ -n "$LAST_BACKUP" ]]; then
          restore_backup_zip "$LAST_BACKUP" && warn "rolled back to $LAST_BACKUP"
        fi
        die "primary deploy failed"
      fi
      DEPLOYED_THIS_RUN=1
    fi
  elif [[ -z "${SLUG:-}" ]]; then
    warn "SLUG not set — skipping backup+deploy"
  fi
fi

# ---- systemd restart + journalctl verify (always if configured)
if [[ -n "${SYSTEMD_UNIT:-}" ]]; then
  stage systemd-restart
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "systemctl restart $SYSTEMD_UNIT && journalctl -u $SYSTEMD_UNIT -n 30 --no-pager"
  else
    sudo systemctl restart "$SYSTEMD_UNIT" || die "systemctl restart $SYSTEMD_UNIT failed"
    sleep 2
    if ! sudo systemctl is-active --quiet "$SYSTEMD_UNIT"; then
      warn "$SYSTEMD_UNIT is not active — recent logs:"
      sudo journalctl -u "$SYSTEMD_UNIT" -n 40 --no-pager || true
      die "$SYSTEMD_UNIT failed to come up after restart"
    fi
    pass "$SYSTEMD_UNIT active"
    log "recent logs ($SYSTEMD_UNIT):"
    sudo journalctl -u "$SYSTEMD_UNIT" -n 20 --no-pager || true
  fi
fi

# ---- smoke test -----------------------------------------------
stage smoke
if [[ $DRY_RUN -eq 1 ]]; then
  dry "smoke-cutover.sh --dist ${DIST:-<dist>} ${SITE_URL:+--url $SITE_URL}"
elif [[ $ROLLBACK -eq 1 && "${ROLLBACK_SMOKE:-0}" != "1" ]]; then
  if [[ -n "${SITE_URL:-}" ]]; then
    code="$(curl -s -o /tmp/pluto-rollback-smoke.$$ -w '%{http_code}' --max-time 10 "$SITE_URL/" || echo 000)"
    rm -f /tmp/pluto-rollback-smoke.$$
    [[ "$code" =~ ^2 ]] || die "rollback site check failed ($SITE_URL → HTTP $code)"
    pass "rollback site reachable ($SITE_URL → HTTP $code)"
  else
    warn "rollback complete; SITE_URL not set, skipping live smoke"
  fi
else
  SMOKE_ARGS=()
  [[ -n "${DIST:-}" ]] && SMOKE_ARGS+=(--dist "$DIST")
  [[ -n "${SITE_URL:-}" ]] && SMOKE_ARGS+=(--url "$SITE_URL")
  if ! bash "$DEPLOY_DIR/smoke-cutover.sh" "${SMOKE_ARGS[@]}"; then
    if [[ $DEPLOYED_THIS_RUN -eq 1 && -n "$LAST_BACKUP" ]]; then
      warn "smoke failed — attempting auto-rollback to $LAST_BACKUP"
      stage rollback-after-smoke
      restore_backup_zip "$LAST_BACKUP" && warn "rolled back to $LAST_BACKUP after smoke failure"
    fi
    die "smoke test failed — inspect above for the failing check (dist-guard / health / auth-settings / auth-session)"
  fi
fi

FAIL_STAGE=""
pass "build-and-cutover finished (dry-run=$DRY_RUN, rollback=$ROLLBACK)"
