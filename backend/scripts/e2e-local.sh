#!/usr/bin/env bash
# End-to-end smoke test for the full local Pluto stack.
#
#   Requires: docker (with `compose` subcommand), curl, jq.
#   Run from anywhere:  bash backend/scripts/e2e-local.sh
#
# What it does:
#   1. Copies .env.local.example -> .env if missing (adds keys).
#   2. `docker compose up -d --build` for postgres + minio + mailpit + pluto.
#   3. Waits for /readyz to return 200.
#   4. Exercises Auth + Storage end-to-end via HTTP:
#        - sign-up a fresh user, capture JWT
#        - service_role creates a private, owner_only bucket
#        - upload a file as the user (owner_id auto-set)
#        - HEAD + GET returns the bytes for the owner
#        - a SECOND user gets 403 on the same key (owner_only RLS works)
#        - mint a signed READ URL, fetch it unauthenticated → 200
#        - delete the object as owner → 204
#   5. Prints PASS/FAIL and preserves the stack unless --down is passed.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

: "${BASE:=http://localhost:8787}"
DOWN=0
[[ "${1:-}" == "--down" ]] && DOWN=1

command -v docker >/dev/null || { echo "docker not installed"; exit 1; }
command -v jq     >/dev/null || { echo "jq not installed";     exit 1; }

if [[ ! -f .env ]]; then
  echo "» seeding .env from .env.local.example"
  cp .env.local.example .env
  # Mint per-run random keys so re-runs don't reuse credentials.
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^ANON_KEY=.*|ANON_KEY=pk_anon_$(openssl rand -hex 8)|" .env
  sed -i "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=sk_svc_$(openssl rand -hex 16)|" .env
fi

ANON=$(grep '^ANON_KEY='         .env | cut -d= -f2-)
SVC=$( grep '^SERVICE_ROLE_KEY=' .env | cut -d= -f2-)

echo "» bringing up docker compose stack"
docker compose up -d --build

echo -n "» waiting for /readyz "
for i in $(seq 1 60); do
  if curl -fsS "$BASE/readyz" >/dev/null 2>&1; then echo " OK"; break; fi
  echo -n "."; sleep 2
  [[ $i -eq 60 ]] && { echo " TIMEOUT"; docker compose logs --tail=100 pluto; exit 1; }
done

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; docker compose logs --tail=60 pluto; exit 1; }

# ── 1. two users ──
E1="e2e_a_$(date +%s)@test.local"; PWD1="pw-owner-1234"
E2="e2e_b_$(date +%s)@test.local"; PWD2="pw-intru-1234"

S1=$(curl -sS -X POST "$BASE/auth/v1/sign-up" -H "apikey: $ANON" -H 'content-type: application/json' \
  -d "{\"email\":\"$E1\",\"password\":\"$PWD1\"}")
T1=$(echo "$S1" | jq -r '.session.access_token')
[[ -n "$T1" && "$T1" != "null" ]] && pass "owner signed up" || fail "owner sign-up: $S1"

S2=$(curl -sS -X POST "$BASE/auth/v1/sign-up" -H "apikey: $ANON" -H 'content-type: application/json' \
  -d "{\"email\":\"$E2\",\"password\":\"$PWD2\"}")
T2=$(echo "$S2" | jq -r '.session.access_token')
[[ -n "$T2" && "$T2" != "null" ]] && pass "intruder signed up" || fail "intruder sign-up: $S2"

# ── 2. bucket ──
BUCKET="e2e-$(date +%s)"
R=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/storage/v1/buckets" \
  -H "apikey: $SVC" -H 'content-type: application/json' \
  -d "{\"name\":\"$BUCKET\",\"public\":false,\"owner_only\":true,\"max_size\":1048576}")
[[ "$R" == "201" ]] && pass "created private owner_only bucket ($BUCKET)" || fail "create bucket got $R"

# ── 3. upload ──
TMP=$(mktemp); echo "hello pluto $(date)" > "$TMP"
R=$(curl -sS -o /tmp/put.json -w '%{http_code}' -X POST "$BASE/storage/v1/object/$BUCKET/hello.txt" \
  -H "apikey: $ANON" -H "authorization: Bearer $T1" -F "file=@$TMP;type=text/plain")
[[ "$R" == "201" ]] && pass "owner uploaded" || fail "upload got $R: $(cat /tmp/put.json)"

# ── 4. owner GET ──
R=$(curl -sS -o /tmp/get.txt -w '%{http_code}' "$BASE/storage/v1/object/$BUCKET/hello.txt" \
  -H "apikey: $ANON" -H "authorization: Bearer $T1")
[[ "$R" == "200" && "$(cat /tmp/get.txt)" == "$(cat "$TMP")" ]] \
  && pass "owner downloaded bytes match" || fail "owner GET $R"

# ── 5. HEAD ──
R=$(curl -sS -o /dev/null -w '%{http_code}' -I "$BASE/storage/v1/object/$BUCKET/hello.txt" \
  -H "apikey: $ANON" -H "authorization: Bearer $T1")
[[ "$R" == "200" ]] && pass "HEAD returns metadata" || fail "HEAD got $R"

# ── 6. intruder blocked ──
R=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/storage/v1/object/$BUCKET/hello.txt" \
  -H "apikey: $ANON" -H "authorization: Bearer $T2")
[[ "$R" == "403" ]] && pass "intruder blocked (403)" || fail "intruder GET expected 403, got $R"

# ── 7. anon blocked ──
R=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/storage/v1/object/$BUCKET/hello.txt" -H "apikey: $ANON")
[[ "$R" == "401" || "$R" == "403" ]] && pass "anon blocked ($R)" || fail "anon GET expected 401/403, got $R"

# ── 8. signed URL ──
SIGN=$(curl -sS -X POST "$BASE/storage/v1/object/sign/$BUCKET/hello.txt" \
  -H "apikey: $ANON" -H "authorization: Bearer $T1" \
  -H 'content-type: application/json' -d '{"expires_in":60,"mode":"read"}')
URL=$(echo "$SIGN" | jq -r '.url')
[[ -n "$URL" && "$URL" != "null" ]] && pass "signed URL minted" || fail "sign: $SIGN"

R=$(curl -sS -o /tmp/sig.txt -w '%{http_code}' "$URL")
[[ "$R" == "200" && "$(cat /tmp/sig.txt)" == "$(cat "$TMP")" ]] \
  && pass "signed URL fetch works unauthenticated" || fail "signed GET $R"

# ── 9. intruder cannot delete ──
R=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$BASE/storage/v1/object/$BUCKET/hello.txt" \
  -H "apikey: $ANON" -H "authorization: Bearer $T2")
[[ "$R" == "403" ]] && pass "intruder DELETE blocked (403)" || fail "intruder DELETE expected 403, got $R"

# ── 10. owner delete ──
R=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$BASE/storage/v1/object/$BUCKET/hello.txt" \
  -H "apikey: $ANON" -H "authorization: Bearer $T1")
[[ "$R" == "200" ]] && pass "owner deleted" || fail "owner DELETE got $R"

echo
echo "════════════════════════════════════════"
echo "  ✅ Storage E2E: 10/10 checks passed"
echo "════════════════════════════════════════"

if [[ $DOWN -eq 1 ]]; then
  echo "» tearing down (--down)"
  docker compose down -v
else
  echo "» stack left running. tear down with:  docker compose -f backend/docker-compose.yml down -v"
fi
