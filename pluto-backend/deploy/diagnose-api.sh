#!/usr/bin/env bash
# diagnose-api.sh — Root-cause 502 from every probe.
# 502 on ALL paths (including /readyz which existed before this change) means
# nginx cannot reach the API upstream: the container is crashed, restarting,
# or listening on the wrong port. This script prints exactly which.
#
# Run on the VPS from the repo root:
#   bash pluto-backend/deploy/diagnose-api.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE="docker compose --env-file $ROOT/.env -f $ROOT/docker/docker-compose.yml"

hr() { printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }

hr "1. container status"
$COMPOSE ps

hr "2. api container health + restart count"
CID=$(docker ps -aqf "name=docker-api-1" | head -n1)
if [[ -z "$CID" ]]; then
  echo "✘ api container not found — is compose project name 'docker'?"
  docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  exit 1
fi
docker inspect --format '  state:     {{.State.Status}}
  running:   {{.State.Running}}
  exitcode:  {{.State.ExitCode}}
  restarts:  {{.RestartCount}}
  health:    {{if .State.Health}}{{.State.Health.Status}} ({{len .State.Health.Log}} checks){{else}}n/a{{end}}
  started:   {{.State.StartedAt}}' "$CID"

hr "3. last 60 api log lines"
$COMPOSE logs --tail=60 --no-color api

hr "4. last healthcheck output (why is it unhealthy)"
docker inspect --format '{{range .State.Health.Log}}exit={{.ExitCode}} @ {{.Start}}
{{.Output}}
---
{{end}}' "$CID" 2>/dev/null | tail -n 40 || echo "(no health log)"

hr "5. probe api from INSIDE the container (bypass nginx)"
docker exec "$CID" sh -c '
  for p in /readyz /v1/health /auth/v1/health; do
    code=$(wget -qO- --server-response --tries=1 --timeout=3 "http://127.0.0.1:3000$p" 2>&1 | grep "HTTP/" | tail -1 | awk "{print \$2}")
    echo "  in-container $p → ${code:-NO_RESPONSE}"
  done
' 2>&1 || echo "✘ docker exec failed — container not running"

hr "6. probe api from the HOST (bypass nginx, use published port)"
for p in /readyz /v1/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:3000$p" || echo "000")
  echo "  host 127.0.0.1:3000$p → $code"
done

hr "7. probe api through nginx (public)"
for p in /readyz /v1/health; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "https://api.timescard.cloud$p" || echo "000")
  echo "  https://api.timescard.cloud$p → $code"
done

hr "8. nginx upstream error log (last 20)"
if [[ -f /var/log/nginx/error.log ]]; then
  tail -n 20 /var/log/nginx/error.log
else
  echo "(no /var/log/nginx/error.log)"
fi

hr "diagnosis"
echo "  • container running + in-container 200 + public 502 → nginx upstream mis-config (proxy_pass port)"
echo "  • container restarting or exitcode!=0            → boot crash; read step 3 log for stack trace"
echo "  • in-container NO_RESPONSE                       → API listens on wrong host/port (bind 0.0.0.0:3000)"
echo "  • health status 'unhealthy'                      → step 4 shows the failing probe body"
