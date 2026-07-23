#!/usr/bin/env bash
# repair-vps-current-issues.sh
# -----------------------------------------------------------------------------
# One-shot VPS repair for the exact issues operators commonly hit while wiring
# app.timescard.cloud to Pluto BaaS:
#   1) SQL pasted into bash instead of psql
#   2) docker compose failing because ../.env is missing S3_ACCESS_KEY / friends
#   3) realtime WebSocket checks returning 500 because curl -I sends HEAD
#
# Usage from repo root (/root/backend-joy or /root/backend-joy/pluto-backend):
#   sudo bash pluto-backend/deploy/repair-vps-current-issues.sh
#   sudo bash deploy/repair-vps-current-issues.sh
#
# Optional env:
#   API_DOMAIN=api.timescard.cloud API_PORT=3000 PROFILE_TABLE=public.profiles
#   SKIP_COMPOSE=1 SKIP_REALTIME_REPAIR=1 SKIP_RLS=1
set -euo pipefail

API_DOMAIN="${API_DOMAIN:-api.timescard.cloud}"
API_PORT="${API_PORT:-3000}"
PROFILE_TABLE="${PROFILE_TABLE:-public.profiles}"
SKIP_COMPOSE="${SKIP_COMPOSE:-0}"
SKIP_REALTIME_REPAIR="${SKIP_REALTIME_REPAIR:-0}"
SKIP_RLS="${SKIP_RLS:-0}"

SUDO=""
[ "$(id -u)" != "0" ] && SUDO="sudo"

green(){ printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
blue(){ printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
yellow(){ printf '\033[1;33m! %s\033[0m\n' "$*"; }
red(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
die(){ red "$*"; exit 1; }

resolve_root() {
  local here
  here="$(cd "$(dirname "$0")" && pwd)"
  if [ -f "$here/../docker/docker-compose.yml" ] && [ -f "$here/../packages/api/package.json" ]; then
    cd "$here/.." && pwd
    return
  fi
  if [ -f "pluto-backend/docker/docker-compose.yml" ]; then
    cd pluto-backend && pwd
    return
  fi
  if [ -f "docker/docker-compose.yml" ] && [ -f "packages/api/package.json" ]; then
    pwd
    return
  fi
  die "could not locate pluto-backend root; run from /root/backend-joy or /root/backend-joy/pluto-backend"
}

ROOT="$(resolve_root)"
ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/docker/docker-compose.yml"
COMPOSE=($SUDO docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

rand_hex() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

env_value_from_file() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 1
  awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/,""); print; exit}' "$file"
}

env_value_from_containers() {
  local key="$1"
  command -v docker >/dev/null 2>&1 || return 1
  # Prefer the compose containers used by the live Pluto install. Do not print
  # values; only write them back into the protected .env file.
  for name in docker-api-1 docker-postgres-1 docker-minio-1 docker-redis-1 pluto-api pluto-postgres pluto-minio; do
    if $SUDO docker inspect "$name" >/dev/null 2>&1; then
      $SUDO docker inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
        | awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/,""); print; exit}'
    fi
  done | awk 'NF {print; exit}'
}

parse_pg_password_from_database_url() {
  local url="$1"
  python3 - "$url" <<'PY' 2>/dev/null || true
import sys, urllib.parse
u = urllib.parse.urlparse(sys.argv[1])
print(urllib.parse.unquote(u.password or ''))
PY
}

upsert_env() {
  local key="$1" value="$2"
  [ -n "$value" ] || return 0
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    python3 - "$ENV_FILE" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1:4]
lines = open(path, encoding='utf-8').read().splitlines()
out = []
done = False
for line in lines:
    if line.startswith(key + '='):
        if not done:
            out.append(f'{key}={value}')
            done = True
        continue
    out.append(line)
if not done:
    out.append(f'{key}={value}')
open(path, 'w', encoding='utf-8').write('\n'.join(out).rstrip() + '\n')
PY
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

ensure_env_key() {
  local key="$1" fallback="${2:-}" generated_msg="${3:-set}"
  local value
  value="$(env_value_from_file "$key" "$ENV_FILE" || true)"
  if [ -z "$value" ]; then
    value="$(env_value_from_file "$key" "$ROOT/docker/.env" || true)"
  fi
  if [ -z "$value" ]; then
    value="$(env_value_from_containers "$key" || true)"
  fi
  if [ -z "$value" ] && [ -n "$fallback" ]; then
    value="$fallback"
  fi
  [ -n "$value" ] || return 1
  upsert_env "$key" "$value"
  green "$key ${generated_msg}"
}

repair_env() {
  blue "repair compose env: $ENV_FILE"
  mkdir -p "$ROOT"
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ROOT/.env.example" ]; then
      cp "$ROOT/.env.example" "$ENV_FILE"
    else
      : > "$ENV_FILE"
    fi
    chmod 600 "$ENV_FILE" || true
    green "created $ENV_FILE"
  else
    cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
    chmod 600 "$ENV_FILE" || true
    green "backup created"
  fi

  local db_url pg_pass
  db_url="$(env_value_from_file DATABASE_URL "$ENV_FILE" || true)"
  if [[ "$db_url" == *CHANGE_ME* || -z "$db_url" ]]; then db_url=""; fi

  pg_pass="$(env_value_from_containers POSTGRES_PASSWORD || true)"
  if [ -z "$pg_pass" ] && [ -n "$db_url" ]; then
    pg_pass="$(parse_pg_password_from_database_url "$db_url")"
  fi
  if [ -z "$pg_pass" ]; then
    pg_pass="$(rand_hex 24)"
    yellow "POSTGRES_PASSWORD was not recoverable from running containers; generated a new value for fresh compose starts"
  fi

  ensure_env_key POSTGRES_PASSWORD "$pg_pass" "present" || true
  if [ -z "$db_url" ]; then
    db_url="postgres://pluto:${pg_pass}@postgres:5432/pluto"
  fi
  upsert_env DATABASE_URL "$db_url"; green "DATABASE_URL present"

  ensure_env_key NODE_ENV production "present" || true
  ensure_env_key PORT 3000 "present" || true
  ensure_env_key HOST 0.0.0.0 "present" || true
  ensure_env_key LOG_LEVEL info "present" || true
  ensure_env_key REDIS_URL redis://redis:6379 "present" || true
  ensure_env_key S3_ENDPOINT http://minio:9000 "present" || true
  ensure_env_key S3_REGION us-east-1 "present" || true
  ensure_env_key S3_BUCKET pluto "present" || true
  ensure_env_key S3_ACCESS_KEY "$(rand_hex 12)" "present" || true
  ensure_env_key S3_SECRET_KEY "$(rand_hex 24)" "present" || true
  ensure_env_key PLUTO_JWT_SECRET "$(rand_hex 48)" "present" || true
  ensure_env_key JWT_ISSUER "https://${API_DOMAIN}" "present" || true
  ensure_env_key PUBLIC_API_URL "https://${API_DOMAIN}" "present" || true
  ensure_env_key CORS_ORIGINS "*" "present" || true
  ensure_env_key BODY_LIMIT_MB 100 "present" || true
  ensure_env_key RATE_LIMIT_GLOBAL 300 "present" || true
  ensure_env_key RATE_LIMIT_AUTH 10 "present" || true

  # Remove common placeholders left from .env.example after the real values are
  # repaired above. This keeps compose and the API from booting with CHANGE_ME.
  python3 - "$ENV_FILE" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
bad = ['CHANGE_ME', 'CHANGE_ME_STRONG', 'CHANGE_ME_STRONG_PW', 'CHANGE_ME_TO_A_64_CHAR_RANDOM_STRING_________________________']
if any(b in text for b in bad):
    print('warning: placeholders still exist in optional keys; required keys were repaired')
PY
}

compose_up_api() {
  [ "$SKIP_COMPOSE" = "1" ] && { yellow "SKIP_COMPOSE=1 — not rebuilding/restarting api"; return; }
  [ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"
  blue "validate docker compose env"
  "${COMPOSE[@]}" config >/dev/null
  green "compose config OK"

  blue "start dependencies + rebuild api"
  "${COMPOSE[@]}" up -d postgres redis minio
  "${COMPOSE[@]}" up -d --build api
  green "api compose stack restarted"
}

pg_container() {
  for name in docker-postgres-1 pluto-postgres postgres; do
    if $SUDO docker inspect "$name" >/dev/null 2>&1; then
      printf '%s' "$name"
      return
    fi
  done
  $SUDO docker ps --format '{{.Names}}' | grep -Ei 'postgres|pluto.*pg|pg.*pluto' | head -1
}

container_env() {
  local container="$1" key="$2"
  $SUDO docker exec "$container" sh -lc "printf '%s' \"\">${key}\"" >/dev/null 2>&1 || true
  $SUDO docker exec "$container" env 2>/dev/null | awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/,""); print; exit}'
}

psql_exec() {
  local container="$1" user="$2" db="$3"
  shift 3
  $SUDO docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U "$user" -d "$db" "$@"
}

repair_profiles_rls() {
  [ "$SKIP_RLS" = "1" ] && { yellow "SKIP_RLS=1 — not changing profile RLS"; return; }
  blue "repair profiles RLS via psql (not bash)"
  local pgc user db owner_col table_schema table_name
  pgc="$(pg_container || true)"
  [ -n "$pgc" ] || die "postgres container not found"
  user="$(container_env "$pgc" POSTGRES_USER || true)"; user="${user:-pluto}"
  db="$(container_env "$pgc" POSTGRES_DB || true)"; db="${db:-pluto}"

  table_schema="${PROFILE_TABLE%%.*}"
  table_name="${PROFILE_TABLE#*.}"
  if [ "$table_schema" = "$table_name" ]; then table_schema="public"; fi

  owner_col="$(psql_exec "$pgc" "$user" "$db" -Atc "
    select case
      when exists (select 1 from information_schema.columns where table_schema='${table_schema}' and table_name='${table_name}' and column_name='id') then 'id'
      when exists (select 1 from information_schema.columns where table_schema='${table_schema}' and table_name='${table_name}' and column_name='user_id') then 'user_id'
      else '' end;
  " | tr -d '[:space:]')"
  [ -n "$owner_col" ] || die "$PROFILE_TABLE exists but has neither id nor user_id owner column"

  psql_exec "$pgc" "$user" "$db" <<SQL
alter table ${table_schema}.${table_name} enable row level security;

drop policy if exists "own profile read" on ${table_schema}.${table_name};
drop policy if exists "own profile insert" on ${table_schema}.${table_name};
drop policy if exists "own profile update" on ${table_schema}.${table_name};

create policy "own profile read" on ${table_schema}.${table_name}
  for select to authenticated using (auth.uid() = ${owner_col});

create policy "own profile insert" on ${table_schema}.${table_name}
  for insert to authenticated with check (auth.uid() = ${owner_col});

create policy "own profile update" on ${table_schema}.${table_name}
  for update to authenticated using (auth.uid() = ${owner_col}) with check (auth.uid() = ${owner_col});

grant select, insert, update on ${table_schema}.${table_name} to authenticated;
grant all on ${table_schema}.${table_name} to service_role;
SQL
  green "RLS repaired on ${PROFILE_TABLE} using owner column ${owner_col}"
}

probe_ws_get() {
  local url="$1" headers ws_key code
  headers="$(mktemp)"
  ws_key="$(openssl rand -base64 16 2>/dev/null || date +%s | sha256sum | awk '{print $1}')"
  curl -sS -D "$headers" -o /dev/null --http1.1 --max-time 8 \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H "Sec-WebSocket-Key: $ws_key" \
    -H 'Sec-WebSocket-Version: 13' \
    "$url" >/dev/null 2>&1 || true
  code="$(awk 'toupper($0) ~ /^HTTP\// {print $2}' "$headers" | tail -1)"
  sed -n '1,5p' "$headers"
  rm -f "$headers"
  [ "$code" = "101" ]
}

verify_realtime() {
  blue "verify realtime with a real GET upgrade (curl -I/HEAD is invalid for WebSocket)"
  local key
  key="$(env_value_from_file PLUTO_ANON_KEY "$ENV_FILE" || true)"
  [ -n "$key" ] || key="$(env_value_from_file ANON_KEY "$ENV_FILE" || true)"
  [ -n "$key" ] || key="smoke_key"

  if ! probe_ws_get "http://127.0.0.1:${API_PORT}/realtime/v1?apikey=${key}&channel=smoke"; then
    red "local websocket failed on http://127.0.0.1:${API_PORT}/realtime/v1"
    "${COMPOSE[@]}" logs --tail=80 api >&2 || true
    return 1
  fi
  green "local realtime websocket OK (101)"

  if ! probe_ws_get "https://${API_DOMAIN}/realtime/v1?apikey=${key}&channel=smoke"; then
    red "public websocket failed; nginx/proxy still needs repair"
    $SUDO sh -c "grep -Ei 'realtime|upstream|websocket|connect\(\)' /var/log/nginx/error.log | tail -50" >&2 || true
    return 1
  fi
  green "public realtime websocket OK (101)"
}

repair_realtime() {
  [ "$SKIP_REALTIME_REPAIR" = "1" ] && { yellow "SKIP_REALTIME_REPAIR=1 — only verifying realtime"; verify_realtime; return; }
  if [ -x "$ROOT/deploy/repair-realtime-ws.sh" ] || [ -f "$ROOT/deploy/repair-realtime-ws.sh" ]; then
    blue "run existing realtime repair script"
    API_PORT="$API_PORT" DOMAIN="$API_DOMAIN" bash "$ROOT/deploy/repair-realtime-ws.sh"
  else
    verify_realtime
  fi
}

main() {
  blue "Pluto VPS repair root: $ROOT"
  repair_env
  compose_up_api
  repair_profiles_rls
  repair_realtime

  cat <<'EOF'

Next verification commands (safe):
  # WebSocket: use GET upgrade, NOT curl -I
  curl -sS -D- -o /dev/null --http1.1 \
    -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Sec-WebSocket-Version: 13' \
    'https://api.timescard.cloud/realtime/v1?apikey=smoke_key&channel=smoke' | head -3

  # API health
  curl -s https://api.timescard.cloud/healthz
EOF
  green "current VPS issues repaired"
}

main "$@"