#!/usr/bin/env bash
# update-env-and-redeploy.sh — Update one or more KEY=VALUE pairs in a .env,
# then re-run docker compose up -d and verify-pluto-cutover.sh.
#
# Usage:
#   sudo bash update-env-and-redeploy.sh \
#     --env /root/backend-joy/pluto-backend/docker/.env \
#     --set VITE_PLUTO_ANON_KEY=pluto_pk_xxx \
#     --set POSTGRES_PASSWORD=secret \
#     --domain app.timescard.cloud
#
# Flags:
#   --env PATH        .env file to update (default: auto-detect first pluto-backend/docker/.env)
#   --set KEY=VALUE   repeatable; upserts the key
#   --compose PATH    docker-compose.yml (default: alongside --env)
#   --domain HOST     domain to pass to verify-pluto-cutover.sh (skip verify if empty)
#   --no-verify       skip cutover verification
set -euo pipefail

ENV_FILE=""
COMPOSE_FILE=""
DOMAIN=""
DO_VERIFY=1
declare -a SETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --compose) COMPOSE_FILE="$2"; shift 2 ;;
    --set) SETS+=("$2"); shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --no-verify) DO_VERIFY=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

green(){ printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
red(){ printf "\033[1;31m✗ %s\033[0m\n" "$*"; }
info(){ printf "\033[1;36m→ %s\033[0m\n" "$*"; }

if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE=$(find /root /opt -maxdepth 6 -path '*pluto-backend/docker/.env' 2>/dev/null | head -1)
fi
[[ -f "$ENV_FILE" ]] || { red ".env not found (use --env PATH)"; exit 1; }
[[ -z "$COMPOSE_FILE" ]] && COMPOSE_FILE="$(dirname "$ENV_FILE")/docker-compose.yml"
[[ -f "$COMPOSE_FILE" ]] || { red "compose file not found: $COMPOSE_FILE"; exit 1; }

info "env    : $ENV_FILE"
info "compose: $COMPOSE_FILE"

# 1. Backup
BAK="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BAK"
green "backup → $BAK"

# 2. Upsert each KEY=VALUE
for kv in "${SETS[@]}"; do
  key="${kv%%=*}"
  val="${kv#*=}"
  if [[ -z "$key" || "$key" = "$kv" ]]; then red "bad --set '$kv' (need KEY=VALUE)"; exit 2; fi
  # escape for sed replacement
  esc=$(printf '%s' "$val" | sed -e 's/[&/\|]/\\&/g')
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE"
    green "updated $key"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
    green "added $key"
  fi
done

# 3. docker compose up
info "docker compose up -d"
if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d; then
  red "docker compose failed — restoring $BAK"
  cp "$BAK" "$ENV_FILE"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d || true
  exit 1
fi
green "compose up complete"

# 4. Wait for API health
info "waiting for api /health ..."
API="${PLUTO_API:-https://api.timescard.cloud}"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$API/health" || echo 000)
  [[ "$code" =~ ^2 ]] && { green "api healthy ($code)"; break; }
  sleep 3
done

# 5. Verify
if [[ "$DO_VERIFY" = "1" && -n "$DOMAIN" ]]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  info "running verify-pluto-cutover.sh $DOMAIN"
  if bash "$HERE/verify-pluto-cutover.sh" "$DOMAIN"; then
    green "==== UPDATE + VERIFY OK ===="
  else
    red "verify failed — .env kept, previous backup at $BAK"
    exit 1
  fi
fi
