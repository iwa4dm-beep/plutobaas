#!/usr/bin/env bash
# One-command deploy: preflight → env check → build+restart api →
# apply pending migrations → verify /admin/v1/sql/run responds 200.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
API_URL="${API_URL:-http://127.0.0.1:3000}"

bash "$HERE/preflight-vps.sh"
bash "$HERE/check-env.sh"

echo "▶ building & restarting api"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build api

echo "▶ applying pending migrations (containerized)"
bash "$HERE/run-migrator.sh"

echo "▶ probing $API_URL/admin/v1/sql/run"
for i in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -s -o /tmp/sql-run.out -w '%{http_code}' "$API_URL/admin/v1/sql/run" || true)"
  if [ "$code" = "200" ]; then
    echo "✔ /admin/v1/sql/run returned 200"
    cat /tmp/sql-run.out; echo
    exit 0
  fi
  echo "  attempt $i: HTTP $code — retrying in 2s"
  sleep 2
done

echo "✘ /admin/v1/sql/run did not return 200 after 10 attempts"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=80 api || true
exit 1
