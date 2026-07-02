#!/usr/bin/env bash
# Storage end-to-end for CI.
#
# Unlike scripts/e2e-local.sh (which spins docker compose), this variant
# assumes Postgres is already reachable via $DATABASE_URL and starts the
# Pluto server directly with `npx tsx src/index.ts` in the background.
# It then runs the same 10-step storage RLS + signed-URL matrix, plus
# a multipart upload round-trip. Non-zero exit fails the CI job.

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE/apps/server"

: "${DATABASE_URL:?DATABASE_URL required}"
: "${ANON_KEY:?ANON_KEY required}"
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY required}"
: "${JWT_SECRET:?JWT_SECRET required}"
export STORAGE_DRIVER="${STORAGE_DRIVER:-local}"
export STORAGE_LOCAL_DIR="${STORAGE_LOCAL_DIR:-/tmp/pluto-storage-ci}"
export PORT="${PORT:-8788}"
mkdir -p "$STORAGE_LOCAL_DIR"
BASE="http://localhost:$PORT"

echo "» applying migrations"
npx tsx src/db/migrate.ts

echo "» starting server on :$PORT"
npx tsx src/index.ts > /tmp/pluto-ci.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; echo "--- server log ---"; tail -80 /tmp/pluto-ci.log' EXIT

for i in $(seq 1 40); do
  curl -fsS "$BASE/readyz" >/dev/null 2>&1 && { echo "  ready"; break; }
  sleep 0.5
  [[ $i -eq 40 ]] && { echo "server never became ready"; exit 1; }
done

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; exit 1; }

E1="ci_owner_$(date +%s%N)@t.local";    PWD1="pw-o-1234"
E2="ci_intruder_$(date +%s%N)@t.local"; PWD2="pw-i-1234"

reg() {
  curl -sS -X POST "$BASE/auth/v1/sign-up" -H "apikey: $ANON_KEY" \
    -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"
}
T1=$(reg "$E1" "$PWD1" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).session.access_token))')
T2=$(reg "$E2" "$PWD2" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).session.access_token))')
[[ -n "$T1" && -n "$T2" ]] && pass "two users registered" || fail "sign-up"

BUCKET="ci-$(date +%s)"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/storage/v1/buckets" \
  -H "apikey: $SERVICE_ROLE_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"$BUCKET\",\"public\":false,\"owner_only\":true,\"max_size\":1048576}" \
  | grep -q '^201$' && pass "bucket created" || fail "bucket"

echo "hello ci $(date)" > /tmp/f.txt
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/storage/v1/object/$BUCKET/hello.txt" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -F "file=@/tmp/f.txt;type=text/plain" \
  | grep -q '^201$' && pass "owner upload" || fail "upload"

curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/storage/v1/object/$BUCKET/hello.txt" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T2" | grep -q '^403$' && pass "intruder blocked" || fail "intruder"

# One-time signed URL — first fetch OK, second fetch 403.
SIGN=$(curl -sS -X POST "$BASE/storage/v1/object/sign/$BUCKET/hello.txt" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d '{"expires_in":60,"mode":"read","one_time":true}')
URL=$(echo "$SIGN" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).url))')
GID=$(echo "$SIGN" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE$URL" | grep -q '^200$' && pass "one-time first use OK" || fail "signed 1"
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE$URL" | grep -q '^403$' && pass "one-time replay refused" || fail "signed replay"

# Revocation.
SIGN2=$(curl -sS -X POST "$BASE/storage/v1/object/sign/$BUCKET/hello.txt" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d '{"expires_in":300,"mode":"read"}')
URL2=$(echo "$SIGN2" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).url))')
GID2=$(echo "$SIGN2" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE "$BASE/storage/v1/object/sign/grants/$GID2" \
  -H "apikey: $SERVICE_ROLE_KEY" | grep -q '^200$' && pass "grant revoked" || fail "revoke"
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE$URL2" | grep -q '^403$' && pass "revoked URL refused" || fail "revoked serve"

# Multipart upload — 3 parts of 100k each.
dd if=/dev/urandom of=/tmp/big.bin bs=1024 count=300 status=none
SIZE=$(stat -c%s /tmp/big.bin 2>/dev/null || stat -f%z /tmp/big.bin)
INIT=$(curl -sS -X POST "$BASE/storage/v1/upload/init" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"bucket\":\"$BUCKET\",\"key\":\"big.bin\",\"size\":$SIZE,\"part_size\":102400,\"content_type\":\"application/octet-stream\"}")
UID_=$(echo "$INIT" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).upload_id))')
[[ -n "$UID_" ]] && pass "multipart init ($UID_)" || { echo "$INIT"; fail "init"; }
PARTS_JSON="["
for i in 1 2 3; do
  OFF=$(( (i-1) * 102400 ))
  dd if=/tmp/big.bin bs=1 count=102400 skip=$OFF of=/tmp/part status=none
  ETAG=$(curl -sS -X PUT "$BASE/storage/v1/upload/$UID_/part/$i" \
    -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" \
    -H 'content-type: application/octet-stream' --data-binary @/tmp/part \
    | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).etag))')
  [[ -n "$ETAG" ]] || fail "part $i"
  PARTS_JSON+="{\"part_number\":$i,\"etag\":\"$ETAG\"}"
  [[ $i -lt 3 ]] && PARTS_JSON+=","
done
PARTS_JSON+="]"
pass "3 parts uploaded (rls re-checked per part)"

curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/storage/v1/upload/$UID_/complete" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"parts\":$PARTS_JSON}" | grep -q '^200$' && pass "complete OK" || fail "complete"

# Intruder cannot complete/abort someone else's session.
INIT2=$(curl -sS -X POST "$BASE/storage/v1/upload/init" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"bucket\":\"$BUCKET\",\"key\":\"steal.bin\",\"size\":1024,\"part_size\":65536}")
UID2=$(echo "$INIT2" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).upload_id))')
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE "$BASE/storage/v1/upload/$UID2/abort" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T2" | grep -q '^403$' && pass "intruder cannot abort" || fail "abort auth"

# ══════════════════════════════════════════════════════════════════════
# Negative multipart tests — every one of these MUST be rejected. If any
# path returns 2xx the server has silently regressed on RLS/state safety
# and CI must fail. Each block is written so that a bad response prints
# both the code and the JSON body for debugging.
# ══════════════════════════════════════════════════════════════════════

# helper: expect a given HTTP status; on mismatch fail loud.
expect_code() {   # $1 expected, $2 actual, $3 label, $4 body
  if [[ "$2" != "$1" ]]; then
    echo "  ✗ $3 — expected HTTP $1, got $2"
    echo "    body: $4"
    exit 1
  fi
  pass "$3 (HTTP $2)"
}

# ── (a) Intruder cannot upload a part into someone else's session ──
INIT_NEG=$(curl -sS -X POST "$BASE/storage/v1/upload/init" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"bucket\":\"$BUCKET\",\"key\":\"neg.bin\",\"size\":204800,\"part_size\":102400}")
UID_NEG=$(echo "$INIT_NEG" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).upload_id))')
[[ -n "$UID_NEG" ]] || fail "init (neg suite)"

dd if=/dev/urandom of=/tmp/negpart bs=1024 count=100 status=none
RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X PUT "$BASE/storage/v1/upload/$UID_NEG/part/1" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T2" \
  -H 'content-type: application/octet-stream' --data-binary @/tmp/negpart)
expect_code 403 "$RES" "intruder cannot PUT part into owner's session" "$(cat /tmp/body)"

# ── (b) Anonymous (no bearer) cannot PUT a part either ──
RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X PUT "$BASE/storage/v1/upload/$UID_NEG/part/1" \
  -H "apikey: $ANON_KEY" -H 'content-type: application/octet-stream' --data-binary @/tmp/negpart)
[[ "$RES" == "401" || "$RES" == "403" ]] && pass "anonymous PUT part refused (HTTP $RES)" \
  || { echo "  ✗ anonymous PUT should be 401/403, got $RES ($(cat /tmp/body))"; exit 1; }

# ── (c) Resume: owner re-uploads part 1 with new content — server
#         must accept (upsert) and hand back the NEW etag. Then upload
#         part 2 with the RIGHT content but complete with a tampered
#         etag → 400 etag_mismatch. ──
dd if=/dev/urandom of=/tmp/p1a bs=1024 count=100 status=none
E1A=$(curl -sS -X PUT "$BASE/storage/v1/upload/$UID_NEG/part/1" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" \
  -H 'content-type: application/octet-stream' --data-binary @/tmp/p1a \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).etag))')
dd if=/dev/urandom of=/tmp/p1b bs=1024 count=100 status=none
E1B=$(curl -sS -X PUT "$BASE/storage/v1/upload/$UID_NEG/part/1" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" \
  -H 'content-type: application/octet-stream' --data-binary @/tmp/p1b \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).etag))')
[[ -n "$E1A" && -n "$E1B" && "$E1A" != "$E1B" ]] \
  && pass "resume: part 1 re-upload replaced etag ($E1A → $E1B)" \
  || fail "resume upsert (E1A=$E1A E1B=$E1B)"

dd if=/dev/urandom of=/tmp/p2 bs=1024 count=100 status=none
E2R=$(curl -sS -X PUT "$BASE/storage/v1/upload/$UID_NEG/part/2" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" \
  -H 'content-type: application/octet-stream' --data-binary @/tmp/p2 \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).etag))')
[[ -n "$E2R" ]] || fail "part 2 upload"

# Tampered etag on complete — flip a byte.
TAMPERED="${E1B:0:-1}$([[ ${E1B: -1} == '0' ]] && echo 1 || echo 0)"
RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X POST "$BASE/storage/v1/upload/$UID_NEG/complete" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"parts\":[{\"part_number\":1,\"etag\":\"$TAMPERED\"},{\"part_number\":2,\"etag\":\"$E2R\"}]}")
expect_code 400 "$RES" "complete with tampered etag refused" "$(cat /tmp/body)"
grep -q 'etag_mismatch' /tmp/body && pass "  → error=etag_mismatch surfaced" \
  || { echo "  ✗ expected etag_mismatch in body: $(cat /tmp/body)"; exit 1; }

# ── (d) Complete with a missing part → 400 ──
RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X POST "$BASE/storage/v1/upload/$UID_NEG/complete" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"parts\":[{\"part_number\":1,\"etag\":\"$E1B\"}]}")
expect_code 400 "$RES" "complete with missing part refused" "$(cat /tmp/body)"

# ── (e) Intruder cannot complete owner's session ──
RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X POST "$BASE/storage/v1/upload/$UID_NEG/complete" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T2" -H 'content-type: application/json' \
  -d "{\"parts\":[{\"part_number\":1,\"etag\":\"$E1B\"},{\"part_number\":2,\"etag\":\"$E2R\"}]}")
expect_code 403 "$RES" "intruder cannot complete owner's session" "$(cat /tmp/body)"

# ── (f) Owner aborts → subsequent part PUT and complete both refused ──
RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X DELETE "$BASE/storage/v1/upload/$UID_NEG/abort" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1")
expect_code 200 "$RES" "owner aborts session" "$(cat /tmp/body)"

RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X PUT "$BASE/storage/v1/upload/$UID_NEG/part/3" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" \
  -H 'content-type: application/octet-stream' --data-binary @/tmp/negpart)
expect_code 409 "$RES" "PUT part after abort refused" "$(cat /tmp/body)"

RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X POST "$BASE/storage/v1/upload/$UID_NEG/complete" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"parts\":[{\"part_number\":1,\"etag\":\"$E1B\"},{\"part_number\":2,\"etag\":\"$E2R\"}]}")
expect_code 409 "$RES" "complete after abort refused" "$(cat /tmp/body)"

# ── (g) Unknown upload id → 404, and empty part body → 400 ──
BOGUS="00000000-0000-0000-0000-000000000000"
RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X PUT "$BASE/storage/v1/upload/$BOGUS/part/1" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" \
  -H 'content-type: application/octet-stream' --data-binary @/tmp/negpart)
expect_code 404 "$RES" "PUT part on unknown upload id refused" "$(cat /tmp/body)"

INIT_EMP=$(curl -sS -X POST "$BASE/storage/v1/upload/init" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"bucket\":\"$BUCKET\",\"key\":\"emp.bin\",\"size\":1024,\"part_size\":65536}")
UID_EMP=$(echo "$INIT_EMP" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).upload_id))')
: > /tmp/empty
RES=$(curl -sS -o /tmp/body -w '%{http_code}' -X PUT "$BASE/storage/v1/upload/$UID_EMP/part/1" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" \
  -H 'content-type: application/octet-stream' --data-binary @/tmp/empty)
expect_code 400 "$RES" "empty part body refused" "$(cat /tmp/body)"
curl -sS -o /dev/null -X DELETE "$BASE/storage/v1/upload/$UID_EMP/abort" \
  -H "apikey: $ANON_KEY" -H "authorization: Bearer $T1" || true

echo
echo "════════════════════════════════════════"
echo "  ✅ Storage CI E2E: signed URLs + multipart + negative RLS all green"
echo "════════════════════════════════════════"
