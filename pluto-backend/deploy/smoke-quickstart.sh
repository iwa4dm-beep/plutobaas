#!/usr/bin/env bash
# Smoke-test every quickstart / health endpoint the Lovable dashboard probes.
# Fails the deploy (exit 1) on any non-200 so 404/401 regressions surface in CI.
#
# Usage:
#   ./smoke-quickstart.sh                       # defaults to https://api.timescard.cloud
#   BASE_URL=http://127.0.0.1:3000 ./smoke-quickstart.sh
set -euo pipefail

BASE_URL="${BASE_URL:-https://api.timescard.cloud}"
BASE_URL="${BASE_URL%/}"

PROBES=(
  "core       /readyz"
  "auth       /auth/v1/health"
  "rest       /rest/v1/health"
  "storage    /storage/v1/health"
  "realtime   /realtime/v1/health"
  "edge       /functions/v1/health"
  "jobs       /jobs/v1/health"
  "admin      /admin/v1/health"
  "tokens     /tokens/v1/health"
  "scopes     /tokens/v1/scopes"
  "coverage   /tokens/v1/coverage"
  "aggregate  /v1/health"
)

AUTH_PROBES=(
  "workspaces /admin/v1/workspaces"
  "projects   /admin/v1/projects"
  "api_tokens /tokens/v1/tokens"
)

fail=0
printf '▶ smoke-testing quickstart probes against %s\n\n' "$BASE_URL"
printf '  %-10s %-28s %s\n' MODULE PATH STATUS

for row in "${PROBES[@]}"; do
  name="${row%% *}"
  path="${row##* }"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$BASE_URL$path" || echo "000")
  if [[ "$code" == "200" ]]; then
    printf '  %-10s %-28s \033[32m✔ %s\033[0m\n' "$name" "$path" "$code"
  else
    printf '  %-10s %-28s \033[31m✘ %s\033[0m\n' "$name" "$path" "$code"
    fail=1
  fi
done

if [[ -n "${ADMIN_JWT:-}" ]]; then
  echo
  printf '  %-10s %-28s %s\n' AUTH_PATH PATH STATUS
  for row in "${AUTH_PROBES[@]}"; do
    name="${row%% *}"
    path="${row##* }"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
      -H "authorization: Bearer ${ADMIN_JWT}" \
      ${ANON_KEY:+-H "apikey: ${ANON_KEY}"} \
      "$BASE_URL$path" || echo "000")
    if [[ "$code" == "200" ]]; then
      printf '  %-10s %-28s \033[32m✔ %s\033[0m\n' "$name" "$path" "$code"
    else
      printf '  %-10s %-28s \033[31m✘ %s\033[0m\n' "$name" "$path" "$code"
      fail=1
    fi
  done
else
  echo
  echo "↷ skipping authenticated create/list route probes (set ADMIN_JWT and optional ANON_KEY to enable)"
fi

echo
if [[ $fail -ne 0 ]]; then
  echo "✘ one or more quickstart probes failed"
  exit 1
fi
echo "✔ all quickstart probes healthy"
