#!/usr/bin/env bash
# End-to-end smoke test for the dashboard's project / workspace / token flows.
#
# Verifies:
#   1. /health/migrations/required = 200      (Phase-17 schema applied)
#   2. POST /admin/v1/workspaces               (create workspace)
#   3. POST /admin/v1/projects                 (create project in workspace)
#   4. POST /admin/v1/projects/:id/keys        (mint anon + service_role keys)
#   5. POST /tokens/v1/tokens                  (mint workspace API token)
#   6. GET  /tokens/v1/whoami   with token     (bearer-token round-trip)
#   7. GET  /tokens/v1/tokens                  (list, must include the new one)
#   8. DELETE /tokens/v1/tokens/:id            (revoke)
#   9. DELETE /admin/v1/projects/:id           (cleanup)
#
# Usage:
#   ADMIN_JWT=<jwt> BASE_URL=https://api.timescard.cloud ./smoke-e2e.sh
#   Optional: ANON_KEY=<pk_anon_...> — sent as `apikey` header if the API
#   requires it for admin routes on your deployment.
set -euo pipefail

BASE_URL="${BASE_URL:-https://api.timescard.cloud}"
BASE_URL="${BASE_URL%/}"

if [[ -z "${ADMIN_JWT:-}" ]]; then
  echo "✘ ADMIN_JWT is required. Sign in to the dashboard and copy the access token." >&2
  exit 2
fi

need_jq() { command -v jq >/dev/null || { echo "✘ jq is required" >&2; exit 2; }; }
need_jq

HDR_AUTH=(-H "authorization: Bearer ${ADMIN_JWT}")
if [[ -n "${ANON_KEY:-}" ]]; then HDR_AUTH+=(-H "apikey: ${ANON_KEY}"); fi
HDR_JSON=(-H 'content-type: application/json')

STAMP="$(date +%s)"
WS_SLUG="e2e-${STAMP}"
PJ_SLUG="e2e-proj-${STAMP}"
TOKEN_NAME="e2e-token-${STAMP}"

fail() { echo -e "\033[31m✘ $*\033[0m" >&2; exit 1; }
ok()   { echo -e "  \033[32m✔\033[0m $*"; }
step() { echo; echo -e "▶ $*"; }

req() { # req METHOD PATH [BODY]  → prints body, exports LAST_STATUS
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o /tmp/pluto_e2e.body -w '%{http_code}' -X "$method" "${HDR_AUTH[@]}" "${HDR_JSON[@]}" --max-time 15)
  if [[ -n "$body" ]]; then args+=(--data "$body"); fi
  LAST_STATUS="$(curl "${args[@]}" "$BASE_URL$path" || echo 000)"
  cat /tmp/pluto_e2e.body
}

expect_status() { # expect_status CODE CONTEXT
  local want="$1" ctx="$2"
  if [[ "$LAST_STATUS" != "$want" ]]; then
    echo -e "\n  ── response body ──"
    cat /tmp/pluto_e2e.body 2>/dev/null || true
    echo
    fail "$ctx: expected HTTP $want, got $LAST_STATUS"
  fi
  ok "$ctx (HTTP $LAST_STATUS)"
}

echo "▶ e2e smoke against $BASE_URL"

step "1. migration preflight"
BODY="$(req GET /health/migrations/required)"; expect_status 200 "required migrations applied"

step "2. create workspace ($WS_SLUG)"
BODY="$(req POST /admin/v1/workspaces "$(jq -nc --arg s "$WS_SLUG" --arg n "E2E $STAMP" '{slug:$s,name:$n}')")"
expect_status 201 "workspace created"
WS_ID="$(echo "$BODY" | jq -r '.workspace.id // .id')"
[[ -n "$WS_ID" && "$WS_ID" != "null" ]] || fail "no workspace id in response: $BODY"
ok "workspace_id=$WS_ID"

step "3. create project ($PJ_SLUG) in workspace"
BODY="$(req POST /admin/v1/projects "$(jq -nc --arg n "E2E project" --arg s "$PJ_SLUG" --arg w "$WS_ID" '{name:$n,slug:$s,workspace_id:$w}')")"
expect_status 201 "project created"
PJ_ID="$(echo "$BODY" | jq -r '.id')"
[[ -n "$PJ_ID" && "$PJ_ID" != "null" ]] || fail "no project id in response: $BODY"
ok "project_id=$PJ_ID"

step "4a. mint anon key on project"
BODY="$(req POST "/admin/v1/projects/$PJ_ID/keys" '{"name":"e2e-anon","kind":"anon"}')"
expect_status 201 "anon key minted"

step "4b. mint service_role key on project"
BODY="$(req POST "/admin/v1/projects/$PJ_ID/keys" '{"name":"e2e-service","kind":"service_role"}')"
expect_status 201 "service_role key minted"

step "5. mint workspace API token ($TOKEN_NAME)"
BODY="$(req POST /tokens/v1/tokens "$(jq -nc --arg n "$TOKEN_NAME" --arg w "$WS_ID" '{name:$n,scopes:["admin:read","usage:read"],workspace_id:$w}')")"
expect_status 201 "workspace token minted"
TOKEN_ID="$(echo "$BODY" | jq -r '.id')"
TOKEN_RAW="$(echo "$BODY" | jq -r '.token')"
[[ -n "$TOKEN_ID" && "$TOKEN_ID" != "null" ]] || fail "no token id in response"
[[ "$TOKEN_RAW" == plt_* ]] || fail "minted token does not start with plt_"
ok "token_id=$TOKEN_ID prefix=$(echo "$TOKEN_RAW" | cut -c1-16)…"

step "6. bearer round-trip: /tokens/v1/whoami"
CODE="$(curl -sS -o /tmp/pluto_e2e.body -w '%{http_code}' -H "authorization: Bearer $TOKEN_RAW" --max-time 15 "$BASE_URL/tokens/v1/whoami" || echo 000)"
[[ "$CODE" == "200" ]] || { cat /tmp/pluto_e2e.body; fail "whoami expected 200, got $CODE"; }
WHO_WS="$(jq -r '.workspace_id' /tmp/pluto_e2e.body)"
[[ "$WHO_WS" == "$WS_ID" ]] || fail "whoami workspace_id mismatch: $WHO_WS vs $WS_ID"
ok "whoami returned workspace_id=$WHO_WS"

step "7. list tokens (must include new one)"
BODY="$(req GET /tokens/v1/tokens)"; expect_status 200 "token list"
echo "$BODY" | jq -e --arg id "$TOKEN_ID" '.tokens[] | select(.id == $id)' >/dev/null \
  || fail "new token $TOKEN_ID missing from list"
ok "listed and found new token"

step "8. revoke token"
BODY="$(req DELETE "/tokens/v1/tokens/$TOKEN_ID")"; expect_status 200 "token revoked"

step "9. cleanup — delete project"
BODY="$(req DELETE "/admin/v1/projects/$PJ_ID")"
if [[ "$LAST_STATUS" != "200" && "$LAST_STATUS" != "204" ]]; then
  echo "  ⚠ project delete returned $LAST_STATUS (leaving $PJ_ID for manual cleanup)"
else
  ok "project deleted"
fi

echo
echo -e "\033[32m✔ end-to-end smoke passed\033[0m  (workspace=$WS_ID project=$PJ_ID token=$TOKEN_ID revoked)"
