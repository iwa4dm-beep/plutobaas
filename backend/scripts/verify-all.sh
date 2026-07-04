#!/usr/bin/env bash
# verify-all.sh — one-shot local verification of the Pluto backend.
#
# What it does, in order:
#   1. Preflight: docker + ports + env
#   2. `docker compose up -d db minio` and wait for healthy
#   3. `bun install` + `bun run migrate`
#   4. Start server in background, wait for /readyz
#   5. Smoke-test every canonical endpoint domain
#   6. Print a green/red summary and exit non-zero on any failure
#
# Usage:
#   cd backend && ./scripts/verify-all.sh
#   KEEP_RUNNING=1 ./scripts/verify-all.sh   # leave server + docker up
#
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# ---------- pretty output --------------------------------------------------
if [ -t 1 ]; then G='\033[32m'; R='\033[31m'; Y='\033[33m'; B='\033[1m'; N='\033[0m'; else G=;R=;Y=;B=;N=; fi
say()  { printf "${B}[verify]${N} %s\n" "$*"; }
ok()   { printf "  ${G}✓${N} %s\n" "$*"; }
fail() { printf "  ${R}✗${N} %s\n" "$*"; FAILS=$((FAILS+1)); }
warn() { printf "  ${Y}!${N} %s\n" "$*"; }

FAILS=0
STEP=0
step() { STEP=$((STEP+1)); printf "\n${B}[%d] %s${N}\n" "$STEP" "$*"; }

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && [ "${KEEP_RUNNING:-0}" != "1" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "${KEEP_RUNNING:-0}" != "1" ]; then
    docker compose down 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------- 1. preflight ---------------------------------------------------
step "Preflight"

command -v docker >/dev/null || { fail "docker not installed"; exit 1; }
docker compose version >/dev/null 2>&1 || { fail "docker compose plugin missing"; exit 1; }
ok "docker + compose present"

command -v bun >/dev/null || { fail "bun not installed — see https://bun.sh"; exit 1; }
ok "bun present ($(bun --version))"

for p in 3000 5433 9000; do
  if lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
    warn "port $p already bound — will collide with docker compose"
  fi
done

# ---------- 2. bring up deps ----------------------------------------------
step "Bring up Postgres + MinIO"
docker compose up -d db minio >/dev/null
for i in $(seq 1 30); do
  docker compose exec -T db pg_isready -U pluto -d pluto >/dev/null 2>&1 && { ok "postgres healthy"; break; }
  sleep 1
  [ "$i" = "30" ] && { fail "postgres never became healthy"; exit 1; }
done
for i in $(seq 1 30); do
  curl -fsS http://localhost:9000/minio/health/ready >/dev/null 2>&1 && { ok "minio healthy"; break; }
  sleep 1
  [ "$i" = "30" ] && { fail "minio never became healthy"; exit 1; }
done

# ---------- 3. install + migrate ------------------------------------------
step "Install deps + run migrations"

export DATABASE_URL="postgres://pluto:pluto@localhost:5433/pluto"
export JWT_SECRET="dev-jwt-secret-change-me-please-32bytes"
export ANON_KEY="dev-anon-key"
export SERVICE_ROLE_KEY="dev-service-role-key"
export S3_ENDPOINT="http://localhost:9000"
export S3_REGION="us-east-1"
export S3_ACCESS_KEY="minio"
export S3_SECRET_KEY="minio1234"
export S3_BUCKET="pluto"
export S3_FORCE_PATH_STYLE="1"
export PORT="3000"
export PLUTO_ENABLE_OBSERVABILITY="1"
export PLUTO_ENABLE_SCALING="1"
export PLUTO_ENABLE_LEGACY="0"

cd apps/server
bun install --silent 2>&1 | tail -3
ok "deps installed"

if bun run migrate 2>/tmp/pluto-migrate.log; then
  N=$(grep -c "applied" /tmp/pluto-migrate.log 2>/dev/null || echo 0)
  ok "migrations applied ($N new)"
else
  fail "migrations failed — see /tmp/pluto-migrate.log"
  tail -30 /tmp/pluto-migrate.log
  exit 1
fi

# ---------- 4. start server -----------------------------------------------
step "Start server + wait for /readyz"
bun run dev > /tmp/pluto-verify.log 2>&1 &
SERVER_PID=$!

READY=0
for i in $(seq 1 40); do
  code=$(curl -s -o /tmp/readyz.json -w "%{http_code}" http://localhost:3000/readyz || echo 000)
  if [ "$code" = "200" ]; then READY=1; ok "server booted ($(cat /tmp/readyz.json))"; break; fi
  sleep 1
done
if [ "$READY" = "0" ]; then
  fail "server never returned /readyz 200"
  tail -60 /tmp/pluto-verify.log
  exit 1
fi

# ---------- 5. smoke tests -------------------------------------------------
step "Endpoint smoke tests"

BASE="http://localhost:3000"
AUTH_H=(-H "apikey: $ANON_KEY" -H "content-type: application/json")
SVC_H=(-H "apikey: $SERVICE_ROLE_KEY" -H "content-type: application/json")

hit() {
  local method="$1" path="$2" want="$3" note="$4"; shift 4
  local code body
  body=$(curl -s -o /tmp/pluto-body -w "%{http_code}" -X "$method" "$BASE$path" "$@" || echo 000)
  code="$body"
  if echo "$want" | grep -qE "(^|,)${code}(,|$)"; then
    ok "$note → $code"
  else
    fail "$note → got $code (want $want)"
    head -c 400 /tmp/pluto-body; echo
  fi
}

# --- core ---
hit GET  /healthz                     200        "healthz (liveness)"
hit GET  /readyz                      200        "readyz (readiness + DB + storage)"
hit GET  /metrics                     200,404    "metrics scrape target"

# --- auth ---
hit POST /auth/v1/sign-up             200,201,400,409 "auth/v1 sign-up" "${AUTH_H[@]}" \
  --data '{"email":"verify+'$$'@example.com","password":"verifypass1234"}'
hit POST /auth/v1/sign-in             200,400,401     "auth/v1 sign-in" "${AUTH_H[@]}" \
  --data '{"email":"verify+'$$'@example.com","password":"verifypass1234"}'

# --- data api v4 ---
hit GET  /rest/v4/rpc                 200,401,404 "data-api v4 rpc list"     "${AUTH_H[@]}"
hit GET  /rest/v4/openapi             200,401,404 "data-api v4 openapi"      "${AUTH_H[@]}"

# --- storage v4 ---
hit GET  /storage/v4/buckets          200,401,404 "storage v4 list buckets"  "${SVC_H[@]}"

# --- realtime v5 ---
hit GET  /rt/v5/shards                200,401,404 "realtime v5 shards"       "${AUTH_H[@]}" -H "x-workspace-id: verify-ws"
hit POST /rt/v5/publish               200,400,401,404 "realtime v5 publish"  "${AUTH_H[@]}" -H "x-workspace-id: verify-ws" \
  --data '{"room":"verify","payload":{"hi":true}}'

# --- vector v3 ---
hit GET  /vec/v3/hnsw/config          200,401,404 "vector v3 hnsw list"      "${AUTH_H[@]}" -H "x-workspace-id: verify-ws"

# --- jobs v2 ---
hit GET  /jobs/v2/workflows           200,401,404 "jobs v2 workflows"        "${AUTH_H[@]}" -H "x-workspace-id: verify-ws"
hit GET  /jobs/v2/runs                200,401,404 "jobs v2 runs"             "${AUTH_H[@]}" -H "x-workspace-id: verify-ws"

# --- edge v7 ---
hit GET  /edge/v7/functions           200,401,404 "edge v7 functions"        "${SVC_H[@]}" -H "x-workspace-id: verify-ws"

# --- observability v3 ---
hit GET  /obs/v3/health               200,404     "observability v3 health"  "${AUTH_H[@]}"

# ---------- 6. summary -----------------------------------------------------
step "Summary"
if [ "$FAILS" = "0" ]; then
  printf "${G}${B}✓ ALL CHECKS PASSED${N}\n"
  printf "Server: %s (pid %s)\n" "$BASE" "$SERVER_PID"
  [ "${KEEP_RUNNING:-0}" = "1" ] && printf "${Y}KEEP_RUNNING=1 — server + docker left up${N}\n"
  exit 0
else
  printf "${R}${B}✗ %d CHECK(S) FAILED${N}\n" "$FAILS"
  printf "Logs: /tmp/pluto-verify.log\n"
  tail -30 /tmp/pluto-verify.log
  exit 1
fi
