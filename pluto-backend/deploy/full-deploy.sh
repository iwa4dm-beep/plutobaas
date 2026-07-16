#!/usr/bin/env bash
# full-deploy.sh — one-command VPS deploy for Pluto sandbox stack.
#
# Runs:
#   1) safe git pull (keeps whitelisted files via KEEP="a b c")
#   2) bootstrap / refresh pluto-sandbox-worker (systemd + env)
#   3) install / refresh nginx sites-proxy (wildcard SSL if requested)
#   4) nginx -t && systemctl reload nginx
#   5) verify-deploy.sh <slug>   (if SLUG given)
#
# Usage:
#   sudo SECRET='<shared-secret>' \
#        ACME_EMAIL='admin@example.com' \
#        WILDCARD='app.example.com' \
#        SLUG='dbhstock-8myjt4' \
#        bash deploy/full-deploy.sh
#
# Optional env:
#   KEEP        space-separated paths safe-pull.sh must restore after stash
#   SKIP_PULL=1 skip git pull step
#   SKIP_SSL=1  pass through to install-sites-proxy.sh (no cert issuance)
#   UPSTREAM    required on first install; existing env value is preserved later
#   SERVICE_KEY required on first install for /sandbox/unpack; existing value is preserved later
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
DEPLOY="$ROOT/deploy"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)."
[ -n "${SECRET:-}" ] || die "SECRET env is required (matches PLUTO_SANDBOX_WORKER_SECRET)."

WILDCARD="${WILDCARD:-app.timescard.cloud}"
ACME_EMAIL="${ACME_EMAIL:-admin@${WILDCARD#*.}}"

# 1) pull
if [ "${SKIP_PULL:-0}" != "1" ]; then
  log "git pull (safe)"
  if [ -x "$DEPLOY/safe-pull.sh" ]; then
    KEEP="${KEEP:-}" bash "$DEPLOY/safe-pull.sh" || die "safe-pull failed"
  else
    git pull --ff-only || die "git pull failed"
  fi
else
  log "skip git pull (SKIP_PULL=1)"
fi

# 2) worker bootstrap
log "reset sandbox worker port"
if [ -f "$DEPLOY/reset-sandbox-worker-port.sh" ]; then
  bash "$DEPLOY/reset-sandbox-worker-port.sh" "${PORT:-8787}" || die "port reset failed"
fi

log "bootstrap pluto-sandbox-worker"
if [ -f "$DEPLOY/bootstrap-sandbox-worker.sh" ]; then
  if ! SECRET="$SECRET" SERVICE_KEY="${SERVICE_KEY:-}" UPSTREAM="${UPSTREAM:-}" bash "$DEPLOY/bootstrap-sandbox-worker.sh"; then
    log "bootstrap failed; running emergency worker repair"
    [ -f "$DEPLOY/repair-sandbox-worker.sh" ] || die "worker bootstrap failed and repair script is missing"
    if ! SECRET="$SECRET" SERVICE_KEY="${SERVICE_KEY:-}" UPSTREAM="${UPSTREAM:-}" bash "$DEPLOY/repair-sandbox-worker.sh"; then
      log "worker repair failed; nuking and rebuilding sandbox worker from scratch"
      [ -f "$DEPLOY/nuke-and-rebuild-sandbox.sh" ] || die "worker repair failed and nuke script is missing"
      KEEP_SITES="${KEEP_SITES:-1}" SECRET="$SECRET" SERVICE_KEY="${SERVICE_KEY:-}" UPSTREAM="${UPSTREAM:-}" WILDCARD="$WILDCARD" ACME_EMAIL="$ACME_EMAIL" SLUG="${SLUG:-}" \
        bash "$DEPLOY/nuke-and-rebuild-sandbox.sh" || die "sandbox nuke/rebuild failed"
    fi
  fi
else
  # fallback: refresh env + copy mjs + restart
  SECRET="$SECRET" SERVICE_KEY="${SERVICE_KEY:-}" UPSTREAM="${UPSTREAM:-}" bash "$DEPLOY/fix-worker-env.sh" || die "fix-worker-env failed"
  install -d /opt/pluto/sandbox-worker
  cp sandbox-worker/sandbox-worker.mjs /opt/pluto/sandbox-worker/
  systemctl restart pluto-sandbox-worker 2>/dev/null || systemctl restart pluto-sandbox
fi

log "force-refresh running worker code"
if [ -f "$DEPLOY/refresh-worker.sh" ]; then
  bash "$DEPLOY/refresh-worker.sh" || die "worker refresh failed"
else
  die "missing $DEPLOY/refresh-worker.sh — git pull did not bring the current deploy scripts"
fi

# 3) nginx sites-proxy
log "install sites-proxy (wildcard=$WILDCARD)"
SKIP_SSL_ARG=""
[ "${SKIP_SSL:-0}" = "1" ] && SKIP_SSL_ARG="--skip-ssl"
ACME_EMAIL="$ACME_EMAIL" bash "$DEPLOY/install-sites-proxy.sh" \
  --wildcard "$WILDCARD" $SKIP_SSL_ARG || die "install-sites-proxy failed"

# 4) nginx reload
log "nginx -t && reload"
nginx -t || die "nginx config invalid"
systemctl reload nginx || die "nginx reload failed"

# 5) verify
if [ -n "${SLUG:-}" ]; then
  log "verify deploy for slug=$SLUG"
  if ! bash "$DEPLOY/verify-deploy.sh" "$SLUG"; then
    log "verify failed; attempting worker + site recovery"
    if [ -f "$DEPLOY/repair-sandbox-worker-and-site.sh" ]; then
      SECRET="$SECRET" SERVICE_KEY="${SERVICE_KEY:-}" UPSTREAM="${UPSTREAM:-}" SLUG="$SLUG" WILDCARD="$WILDCARD" ACME_EMAIL="$ACME_EMAIL" \
        bash "$DEPLOY/repair-sandbox-worker-and-site.sh" || die "worker/site recovery failed"
    else
      die "verify-deploy reported failures and recovery script is missing"
    fi
  fi
else
  log "no SLUG given — skipping end-to-end verification"
  echo "  (rerun: bash deploy/verify-deploy.sh <slug>)"
fi

printf '\n\033[1;32m✓ full-deploy completed\033[0m\n'
