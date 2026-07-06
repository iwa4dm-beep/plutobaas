#!/usr/bin/env bash
# recover-api.sh — Common recovery flow when every probe returns 502.
# Run AFTER diagnose-api.sh has pinpointed the failure, or as a blind
# "kick everything and re-verify" when you just want the service back up.
#
# Usage on VPS:
#   bash pluto-backend/deploy/recover-api.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE="docker compose --env-file $ROOT/.env -f $ROOT/docker/docker-compose.yml"

hr() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

hr "1/6  pull latest code"
git -C "$(cd "$ROOT/.." && pwd)" pull --ff-only

hr "2/6  full rebuild (no cache)"
$COMPOSE build --no-cache api

hr "3/6  stop + remove api container (clears bad state)"
$COMPOSE rm -sf api || true

hr "4/6  start postgres/redis first, wait for healthy"
$COMPOSE up -d postgres redis
for i in 1 2 3 4 5 6 7 8 9 10; do
  if docker inspect --format '{{.State.Health.Status}}' docker-postgres-1 2>/dev/null | grep -q healthy; then
    echo "  ✔ postgres healthy"; break
  fi
  echo "  … waiting for postgres ($i/10)"; sleep 2
done

hr "5/6  start api + wait 15s for boot"
$COMPOSE up -d api
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3000/readyz || echo 000)
  if [[ "$code" == "200" ]]; then echo "  ✔ api ready after ${i}s"; break; fi
  sleep 1
done

hr "6/6  smoke test through nginx"
BASE_URL="${BASE_URL:-https://api.timescard.cloud}" bash "$HERE/smoke-quickstart.sh" || {
  echo
  echo "✘ still failing — run: bash $HERE/diagnose-api.sh"
  exit 1
}
echo
echo "✔ recovery complete"
