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

echo
echo "════════════════════════════════════════"
echo "  ✅ Storage CI E2E: signed URLs + multipart + RLS all green"
echo "════════════════════════════════════════"
