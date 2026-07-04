#!/usr/bin/env bash
# Wave 3 boot smoke test.
# Brings up Postgres + MinIO, runs migrations, starts the server, and asserts
# GET /readyz returns 200. Exits non-zero on any failure.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

log() { printf "[smoke] %s\n" "$*"; }

log "starting docker deps (postgres, minio)"
docker compose up -d db minio

log "waiting for postgres"
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U pluto -d pluto >/dev/null 2>&1; then break; fi
  sleep 1
done

log "waiting for minio"
for i in $(seq 1 30); do
  if curl -fsS http://localhost:9000/minio/health/ready >/dev/null 2>&1; then break; fi
  sleep 1
done

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

cd apps/server

log "running migrations"
bun run migrate || npm run migrate

log "starting server in background"
bun run dev > /tmp/pluto-smoke.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

log "waiting for /readyz"
for i in $(seq 1 40); do
  code=$(curl -s -o /tmp/pluto-readyz.json -w "%{http_code}" "http://localhost:3000/readyz" || echo "000")
  if [ "$code" = "200" ]; then
    log "readyz OK ($code)"
    cat /tmp/pluto-readyz.json
    echo
    exit 0
  fi
  sleep 1
done

log "readyz failed — last 60 log lines:"
tail -n 60 /tmp/pluto-smoke.log || true
exit 1
