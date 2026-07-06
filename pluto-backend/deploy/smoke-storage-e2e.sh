#!/usr/bin/env bash
# smoke-storage-e2e.sh — end-to-end proof that the auth + data + storage
# loop works against a live backend-joy deployment. Exercises exactly the
# path a Lovable frontend takes:
#
#   1. sign up (or sign in) a test user via /auth/v1/*
#   2. upsert a row in public.notes via /rest/v1/notes            (RLS-scoped)
#   3. upload a file to storage bucket `uploads` via /storage/v1  (per-user)
#   4. list the file
#   5. delete row + file to prove revoke works
#
# On any 4xx/5xx the script prints the response body AND the x-request-id
# header so operators can grep the API log:
#   docker logs -f api | grep <trace-id>
#
# Usage:
#   BASE_URL=https://api.timescard.cloud \
#   ANON_KEY=pk_anon_xxx \
#   TEST_EMAIL=e2e@example.com TEST_PASSWORD='StrongPass!23' \
#     bash deploy/smoke-storage-e2e.sh
set -euo pipefail

BASE_URL="${BASE_URL:-https://api.timescard.cloud}"; BASE_URL="${BASE_URL%/}"
ANON_KEY="${ANON_KEY:?set ANON_KEY (publishable pk_anon_...)}"
TEST_EMAIL="${TEST_EMAIL:-e2e+$(date +%s)@example.com}"
TEST_PASSWORD="${TEST_PASSWORD:-Passw0rd!e2e}"

command -v jq >/dev/null || { echo "✘ jq required"; exit 2; }

R='\033[31m'; G='\033[32m'; Y='\033[33m'; N='\033[0m'
ok()   { echo -e "  ${G}✔${N} $*"; }
warn() { echo -e "  ${Y}!${N} $*"; }
fail() { echo -e "${R}✘ $*${N}"; [ -f /tmp/e2e.hdr ] && grep -i '^x-request-id' /tmp/e2e.hdr || true; [ -f /tmp/e2e.body ] && { echo "── body ──"; cat /tmp/e2e.body; echo; }; exit 1; }
step() { echo; echo -e "▶ $*"; }

# call METHOD PATH [-H ...] [-d body] → prints body; sets LAST_CODE, LAST_TRACE
call() {
  local method="$1" path="$2"; shift 2
  LAST_CODE="$(curl -sS -D /tmp/e2e.hdr -o /tmp/e2e.body -w '%{http_code}' \
    -X "$method" -H "apikey: $ANON_KEY" --max-time 20 "$@" "$BASE_URL$path" || echo 000)"
  LAST_TRACE="$(awk 'tolower($1)=="x-request-id:"{print $2}' /tmp/e2e.hdr | tr -d '\r' | head -1)"
  cat /tmp/e2e.body
}
expect() { local want="$1" ctx="$2"; [[ "$LAST_CODE" == "$want" ]] || fail "$ctx: want $want got $LAST_CODE (trace=$LAST_TRACE)"; ok "$ctx (HTTP $LAST_CODE, trace=$LAST_TRACE)"; }

echo "▶ storage E2E against $BASE_URL as $TEST_EMAIL"

step "1. sign up (idempotent — 409 counted as ok)"
BODY="$(call POST /auth/v1/sign-up -H 'content-type: application/json' \
  -d "$(jq -nc --arg e "$TEST_EMAIL" --arg p "$TEST_PASSWORD" '{email:$e,password:$p}')")"
[[ "$LAST_CODE" == "200" || "$LAST_CODE" == "201" || "$LAST_CODE" == "409" ]] \
  || fail "sign-up: unexpected $LAST_CODE (trace=$LAST_TRACE)"
ok "sign-up ok (HTTP $LAST_CODE, trace=$LAST_TRACE)"

step "2. sign in → capture access_token"
BODY="$(call POST /auth/v1/sign-in -H 'content-type: application/json' \
  -d "$(jq -nc --arg e "$TEST_EMAIL" --arg p "$TEST_PASSWORD" '{email:$e,password:$p}')")"
expect 200 "sign-in"
JWT="$(echo "$BODY" | jq -r '.access_token // .session.access_token')"
USER_ID="$(echo "$BODY" | jq -r '.user.id // .session.user.id')"
[[ -n "$JWT" && "$JWT" != "null" ]] || fail "no access_token in sign-in response"
ok "user_id=$USER_ID"

AUTH=(-H "authorization: Bearer $JWT")

step "3. insert row in public.notes via /rest/v1 (RLS: owner_id=auth.uid)"
BODY="$(call POST /rest/v1/notes "${AUTH[@]}" \
  -H 'content-type: application/json' -H 'prefer: return=representation' \
  -d "$(jq -nc --arg t "e2e note $(date +%s)" --arg u "$USER_ID" '{title:$t,body:"hello",owner_id:$u}')")"
expect 201 "insert notes"
NOTE_ID="$(echo "$BODY" | jq -r '.[0].id // .id')"
ok "note_id=$NOTE_ID"

step "4. list rows (must include the new one)"
BODY="$(call GET "/rest/v1/notes?select=id,title&id=eq.$NOTE_ID" "${AUTH[@]}")"
expect 200 "list notes"
echo "$BODY" | jq -e --arg id "$NOTE_ID" '.[] | select(.id==$id)' >/dev/null \
  || fail "new note $NOTE_ID missing from list"
ok "row visible under RLS"

step "5. upload file to storage bucket 'uploads' (path = <user_id>/hello.txt)"
TMPFILE="$(mktemp)"; echo "e2e hello $(date -u +%FT%TZ)" > "$TMPFILE"
BODY="$(call POST "/storage/v1/object/uploads/${USER_ID}/hello-${$}.txt" "${AUTH[@]}" \
  -H 'content-type: text/plain' --data-binary "@$TMPFILE")"
expect 200 "upload"

step "6. list objects under user prefix"
BODY="$(call POST "/storage/v1/object/list/uploads" "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg p "$USER_ID" '{prefix:$p,limit:50}')")"
expect 200 "list"
echo "$BODY" | jq -e --arg n "hello-${$}.txt" '.[] | select(.name==$n)' >/dev/null \
  || fail "uploaded file missing from list"
ok "file listed"

step "7. delete file"
BODY="$(call DELETE "/storage/v1/object/uploads/${USER_ID}/hello-${$}.txt" "${AUTH[@]}")"
[[ "$LAST_CODE" == "200" || "$LAST_CODE" == "204" ]] || fail "delete file: $LAST_CODE (trace=$LAST_TRACE)"
ok "file deleted (HTTP $LAST_CODE)"

step "8. delete note"
BODY="$(call DELETE "/rest/v1/notes?id=eq.$NOTE_ID" "${AUTH[@]}")"
[[ "$LAST_CODE" == "200" || "$LAST_CODE" == "204" ]] || fail "delete note: $LAST_CODE (trace=$LAST_TRACE)"
ok "note deleted"

rm -f "$TMPFILE" /tmp/e2e.hdr /tmp/e2e.body
echo
echo -e "${G}✔ storage E2E passed${N}  user=$USER_ID"
