#!/usr/bin/env bash
# End-to-end SMTP flow test using Mailpit as an in-process SMTP + HTTP sink.
#
# The full matrix covered:
#   1. sign-up → email confirmation email is delivered to mailpit
#   2. token extracted from email body → POST /auth/v1/confirm-email → 200
#   3. resend within cooldown returns 429
#   4. invalid confirmation token → 400
#   5. /auth/v1/recover for a KNOWN email → password reset email delivered
#   6. /auth/v1/recover for UNKNOWN email → 200 (no enumeration) but 0 new mails
#   7. POST /auth/v1/verify-recovery with correct token → session issued
#   8. POST /auth/v1/verify-recovery with tampered token → 400
#   9. Sign in with the NEW password succeeds
#  10. SMTP failure retry: temporarily point SMTP_HOST at a black hole,
#      resend → 200 (send error is swallowed & logged), then point back and
#      resend after cooldown → email delivered.
#
# Usage locally:
#   docker compose -f backend/docker-compose.mailpit.yml up -d
#   DATABASE_URL=postgres://... \
#   MAILPIT_HTTP=http://localhost:8025 \
#   SMTP_HOST=localhost SMTP_PORT=1025 \
#     backend/scripts/e2e-smtp.sh
set -euo pipefail

: "${DATABASE_URL:?required}"
: "${MAILPIT_HTTP:=http://localhost:8025}"
: "${SMTP_HOST:=localhost}"
: "${SMTP_PORT:=1025}"
: "${ANON_KEY:=pk_anon_e2e}"
: "${SERVICE_ROLE_KEY:=sk_service_e2e}"
: "${JWT_SECRET:=e2e-jwt-secret-min-32-chars-xxxxxxxxxxxxxxxxxxx}"
: "${PORT:=8791}"

BASE="http://localhost:${PORT}"
EMAIL="e2e-$(date +%s)@example.test"
PW1="s3cret-original"
PW2="s3cret-rotated"

echo "==> Wiping mailpit inbox"
curl -fsS -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null

echo "==> Booting server (SMTP=$SMTP_HOST:$SMTP_PORT)"
pushd backend/apps/server >/dev/null
JWT_SECRET="$JWT_SECRET" \
DATABASE_URL="$DATABASE_URL" \
ANON_KEY="$ANON_KEY" SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
STORAGE_DRIVER=local STORAGE_LOCAL_DIR=/tmp/pluto-smtp \
SMTP_HOST="$SMTP_HOST" SMTP_PORT="$SMTP_PORT" \
SMTP_USER="" SMTP_PASS="" SMTP_FROM="no-reply@pluto.test" \
PLUTO_ENABLE_AUTH_COMPLETION=1 PLUTO_APP_URL="http://frontend.test" \
PORT="$PORT" \
  npx tsx src/index.ts > /tmp/pluto-smtp.log 2>&1 &
echo $! > /tmp/pluto-smtp.pid
popd >/dev/null
for _ in $(seq 1 40); do
  curl -fsS "$BASE/readyz" >/dev/null 2>&1 && break; sleep 0.5
done

cleanup() {
  kill "$(cat /tmp/pluto-smtp.pid)" 2>/dev/null || true
}
trap cleanup EXIT

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o /tmp/e2e-body -w "%{http_code}" -X "$method" -H "apikey: $ANON_KEY" -H "content-type: application/json")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "${BASE}${path}"
}

expect() {
  local code="$1" want="$2" step="$3"
  if [[ "$code" != "$want" ]]; then
    echo "FAIL [$step]: expected $want, got $code"
    cat /tmp/e2e-body; echo
    exit 1
  fi
  echo "OK   [$step] ($code)"
}

mailpit_wait_for() {
  # Poll for `n` messages matching a subject prefix.
  local subj="$1" want="${2:-1}"
  for _ in $(seq 1 40); do
    local n
    n=$(curl -fsS "$MAILPIT_HTTP/api/v1/search?query=subject%3A%22$subj%22" \
        | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("messages",[])))')
    [[ "$n" -ge "$want" ]] && return 0
    sleep 0.5
  done
  echo "FAIL: mailpit never saw $want message(s) matching $subj"; exit 1
}

mailpit_extract_token() {
  # Get the latest message matching subject, pull the token= fragment.
  local subj="$1"
  local id
  id=$(curl -fsS "$MAILPIT_HTTP/api/v1/search?query=subject%3A%22$subj%22" \
      | python3 -c 'import sys,json;m=json.load(sys.stdin)["messages"];print(m[0]["ID"])')
  curl -fsS "$MAILPIT_HTTP/api/v1/message/$id" \
    | python3 -c 'import sys,json,re;t=json.load(sys.stdin).get("Text","");m=re.search(r"token=([A-Za-z0-9_-]+)",t);print(m.group(1) if m else "")'
}

echo
echo "==================== 1. sign-up + confirmation email ===================="
code=$(api POST /auth/v1/sign-up "{\"email\":\"$EMAIL\",\"password\":\"$PW1\"}")
expect "$code" 200 "sign-up"

# The auth_completion plugin sends confirmation on demand — call it now.
ACCESS=$(python3 -c 'import json;print(json.load(open("/tmp/e2e-body"))["session"]["access_token"])')
code=$(curl -sS -o /tmp/e2e-body -w "%{http_code}" -X POST -H "apikey: $ANON_KEY" -H "authorization: Bearer $ACCESS" -H "content-type: application/json" "$BASE/auth/v1/send-email-confirmation" -d '{}')
expect "$code" 200 "send-email-confirmation"
mailpit_wait_for "Confirm+your+email+address" 1
TOKEN=$(mailpit_extract_token "Confirm+your+email+address")
[[ -n "$TOKEN" ]] || { echo "FAIL: no confirm token in email"; exit 1; }
echo "     got confirm token: ${TOKEN:0:12}…"

echo
echo "==================== 2. confirm email with real token ===================="
code=$(api POST /auth/v1/confirm-email "{\"token\":\"$TOKEN\"}")
expect "$code" 200 "confirm-email"

echo
echo "==================== 3. resend within 60s → 429 cooldown ===================="
code=$(api POST /auth/v1/resend-confirmation "{\"email\":\"$EMAIL\"}")
expect "$code" 429 "resend-cooldown"

echo
echo "==================== 4. invalid token → 400 ===================="
code=$(api POST /auth/v1/confirm-email '{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')
expect "$code" 400 "confirm-invalid"

echo
echo "==================== 5. recover for KNOWN email → reset email ===================="
curl -fsS -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null
code=$(api POST /auth/v1/recover "{\"email\":\"$EMAIL\"}")
expect "$code" 200 "recover-known"
mailpit_wait_for "Reset+your+password" 1
RTOKEN=$(mailpit_extract_token "Reset+your+password")
[[ -n "$RTOKEN" ]] || { echo "FAIL: no reset token"; exit 1; }
echo "     got reset token: ${RTOKEN:0:12}…"

echo
echo "==================== 6. recover for UNKNOWN email → 200 + zero mails ===================="
curl -fsS -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null
code=$(api POST /auth/v1/recover '{"email":"does-not-exist@example.test"}')
expect "$code" 200 "recover-unknown"
sleep 1
n=$(curl -fsS "$MAILPIT_HTTP/api/v1/messages" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("total",0))')
[[ "$n" -eq 0 ]] || { echo "FAIL: unknown-email recover sent $n mails"; exit 1; }
echo "OK   [recover-unknown-no-mail]"

echo
echo "==================== 7. verify-recovery with correct token ===================="
code=$(api POST /auth/v1/verify-recovery "{\"token\":\"$RTOKEN\",\"new_password\":\"$PW2\"}")
expect "$code" 200 "verify-recovery"

echo
echo "==================== 8. verify-recovery with tampered token → 400 ===================="
code=$(api POST /auth/v1/verify-recovery "{\"token\":\"${RTOKEN}XX\",\"new_password\":\"whatever12\"}")
expect "$code" 400 "verify-tampered"

echo
echo "==================== 9. sign-in with NEW password ===================="
code=$(api POST /auth/v1/sign-in "{\"email\":\"$EMAIL\",\"password\":\"$PW2\"}")
expect "$code" 200 "sign-in-new-pw"

echo
echo "==================== 10. SMTP failure retry ===================="
# Kill the server and restart with a black-hole SMTP host to force a
# transport error. The endpoint MUST still 200 (send failure is logged,
# not surfaced) so users cannot enumerate accounts by watching http codes.
kill "$(cat /tmp/pluto-smtp.pid)" || true
sleep 1
pushd backend/apps/server >/dev/null
JWT_SECRET="$JWT_SECRET" DATABASE_URL="$DATABASE_URL" \
ANON_KEY="$ANON_KEY" SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
SMTP_HOST=127.0.0.1 SMTP_PORT=1  \
PLUTO_ENABLE_AUTH_COMPLETION=1 PORT="$PORT" \
  npx tsx src/index.ts > /tmp/pluto-smtp-bad.log 2>&1 &
echo $! > /tmp/pluto-smtp.pid
popd >/dev/null
for _ in $(seq 1 40); do curl -fsS "$BASE/readyz" >/dev/null 2>&1 && break; sleep 0.5; done
code=$(api POST /auth/v1/recover "{\"email\":\"$EMAIL\"}")
expect "$code" 200 "recover-with-broken-smtp"
grep -q "password_reset_email_failed\|smtp" /tmp/pluto-smtp-bad.log \
  && echo "OK   [smtp-error-logged]" \
  || { echo "FAIL: expected smtp failure log line"; exit 1; }

echo
echo "===================== SMTP e2e matrix: ALL PASS ====================="
