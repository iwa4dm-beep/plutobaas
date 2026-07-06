#!/usr/bin/env bash
# One-shot repair + verify for the Pluto API stack.
#
# Fixes the three problems seen on VPS:
#   1) `.env` missing S3_ACCESS_KEY (docker compose fails to start MinIO)
#   2) smoke probes returning 000000 (curl couldn't connect — API not
#      reachable yet, or nginx not proxying) — we wait for /livez first
#      and probe locally BEFORE the public URL
#   3) ADMIN_JWT never captured because operator pasted `<paste-jwt>`
#      literally — we mint one via /auth/v1/token using SUPERADMIN creds
#
# Usage (from ~/backend-joy/pluto-backend):
#   bash deploy/verify-all.sh
#
# Optional env:
#   BASE_URL          public API URL   (default https://api.timescard.cloud)
#   LOCAL_URL         in-VPS API URL   (default http://127.0.0.1:3000)
#   SUPERADMIN_EMAIL  for token mint   (prompted if unset)
#   SUPERADMIN_PASS   for token mint   (prompted if unset, hidden input)
#   SKIP_E2E=1        skip end-to-end
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

BASE_URL="${BASE_URL:-https://api.timescard.cloud}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:3000}"
COMPOSE=(docker compose --env-file .env -f docker/docker-compose.yml)

log()  { printf '\033[36m▶\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1) ensure .env has every required key (auto-generate randoms) ──────────
log "checking .env for required variables"
[[ -f .env ]] || die ".env not found in $ROOT — copy .env.example and re-run"

# secret_or_generate NAME [LEN]
ensure_secret() {
  local name="$1" len="${2:-32}"
  if ! grep -qE "^${name}=..+" .env; then
    local val; val="$(openssl rand -hex "$len")"
    printf '%s=%s\n' "$name" "$val" >> .env
    ok "generated $name (${#val} chars) and appended to .env"
  else
    ok "$name present"
  fi
}
# ensure_literal NAME VALUE  (only if missing)
ensure_literal() {
  local name="$1" val="$2"
  if ! grep -qE "^${name}=..+" .env; then
    printf '%s=%s\n' "$name" "$val" >> .env
    ok "set $name=$val (default)"
  else
    ok "$name present"
  fi
}

ensure_secret  S3_ACCESS_KEY 12
ensure_secret  S3_SECRET_KEY 24
ensure_literal S3_BUCKET     pluto
ensure_literal S3_REGION     us-east-1
ensure_secret  PLUTO_JWT_SECRET 32
ensure_literal AUTO_MIGRATE  1

# ── 2) rebuild + start ─────────────────────────────────────────────────────
log "docker compose build api (no cache)"
"${COMPOSE[@]}" build --no-cache api >/dev/null
ok "image built"

log "docker compose up -d"
"${COMPOSE[@]}" up -d >/dev/null
ok "containers up"

# ── 3) wait for /livez on the LOCAL URL before probing the public one ──────
log "waiting for API /livez on $LOCAL_URL (up to 90s)"
for i in $(seq 1 45); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$LOCAL_URL/livez" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]] && { ok "API live after ${i}×2s"; break; }
  sleep 2
  [[ "$i" == "45" ]] && {
    warn "API never returned 200 on /livez — dumping last 60 log lines"
    "${COMPOSE[@]}" logs --tail 60 api || true
    die "API failed to boot"
  }
done

# ── 4) run quickstart smoke against LOCAL first, then public ───────────────
log "quickstart smoke (LOCAL_URL=$LOCAL_URL)"
BASE_URL="$LOCAL_URL" bash deploy/smoke-quickstart.sh || die "local smoke failed"

log "quickstart smoke (BASE_URL=$BASE_URL)"
if ! BASE_URL="$BASE_URL" bash deploy/smoke-quickstart.sh; then
  warn "public smoke failed — check nginx / DNS / TLS termination for $BASE_URL"
  warn "the API itself is healthy on $LOCAL_URL, so this is an edge-routing issue"
fi

# ── 5) mint an ADMIN_JWT via /auth/v1/token, run e2e ───────────────────────
if [[ "${SKIP_E2E:-0}" == "1" ]]; then
  ok "SKIP_E2E=1 — skipping end-to-end"
  exit 0
fi

if [[ -z "${SUPERADMIN_EMAIL:-}" ]]; then
  read -r -p "superadmin email: " SUPERADMIN_EMAIL
fi
if [[ -z "${SUPERADMIN_PASS:-}" ]]; then
  read -r -s -p "superadmin password: " SUPERADMIN_PASS; echo
fi

log "minting ADMIN_JWT via $LOCAL_URL/auth/v1/token"
TOKEN_JSON="$(curl -sS --max-time 10 -H 'content-type: application/json' \
  -d "$(printf '{"grant_type":"password","email":%s,"password":%s}' \
        "$(printf '%s' "$SUPERADMIN_EMAIL" | jq -Rs .)" \
        "$(printf '%s' "$SUPERADMIN_PASS"  | jq -Rs .)")" \
  "$LOCAL_URL/auth/v1/token")"

ADMIN_JWT="$(printf '%s' "$TOKEN_JSON" | jq -r '.access_token // .session.access_token // empty')"
[[ -n "$ADMIN_JWT" ]] || { echo "$TOKEN_JSON" | jq . 2>/dev/null || echo "$TOKEN_JSON"; die "could not extract access_token"; }
ok "ADMIN_JWT captured (${#ADMIN_JWT} chars)"

log "running end-to-end smoke against $LOCAL_URL"
ADMIN_JWT="$ADMIN_JWT" BASE_URL="$LOCAL_URL" bash deploy/smoke-e2e.sh

echo
ok "verify-all completed. Public URL: $BASE_URL — Local URL: $LOCAL_URL"
