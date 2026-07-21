#!/usr/bin/env bash
# Smoke test: provision a slug, rotate its secret, then verify the wildcard
# subdomain serves the app over HTTPS with a valid SSL certificate.
#
# Usage:
#   SLUG=smoke-$(date +%s) APEX=app.timescard.app API=api.timescard.cloud \
#     SECRET=... bash smoke-provision-and-verify.sh
#
# Env:
#   SLUG    - target slug (default: smoke-<epoch>)
#   APEX    - wildcard apex (default: app.timescard.app)
#   API     - API host used by the worker admin surface (default: api.<APEX-suffix>)
#   SECRET  - x-sandbox-secret. If unset, read from /etc/pluto/sandbox-worker.env
#             or PLUTO_SANDBOX_SECRET env var.
set -euo pipefail

APEX="${APEX:-app.timescard.app}"
SLUG="${SLUG:-smoke-$(date +%s)}"
API="${API:-api.${APEX#app.}}"
HOST="${SLUG}.${APEX}"
URL="https://${HOST}"

if [ -z "${SECRET:-}" ]; then
  if [ -r /etc/pluto/sandbox-worker.env ]; then
    # shellcheck disable=SC1091
    . /etc/pluto/sandbox-worker.env
    SECRET="${SECRET:-${PLUTO_SANDBOX_SECRET:-${SANDBOX_SHARED_SECRET:-}}}"
  fi
fi
SECRET="${SECRET:-${PLUTO_SANDBOX_SECRET:-}}"

if [ -z "${SECRET:-}" ]; then
  echo "✘ SECRET is required (x-sandbox-secret). Set SECRET=... or ensure /etc/pluto/sandbox-worker.env has SECRET/PLUTO_SANDBOX_SECRET." >&2
  exit 2
fi

command -v jq >/dev/null || { echo "✘ jq is required"; exit 2; }
command -v openssl >/dev/null || { echo "✘ openssl is required"; exit 2; }

pass() { printf "  ✓ %s\n" "$*"; }
fail() { printf "  ✗ %s\n" "$*" >&2; FAILED=1; }
step() { printf "\n▶ %s\n" "$*"; }
FAILED=0

step "1/5 Provision subdomain + seed placeholder + rotate secret ($SLUG)"
PROV_JSON=$(curl -sS -X POST "https://${API}/sandbox/admin/provision" \
  -H "x-sandbox-secret: ${SECRET}" -H "content-type: application/json" \
  --max-time 30 \
  -d "$(jq -nc --arg slug "$SLUG" --arg base "$APEX" \
       '{slug:$slug, baseDomain:$base, seed:true, rotateSecret:true, revealSecret:true}')") || true
echo "$PROV_JSON" | jq . 2>/dev/null || echo "$PROV_JSON"
if echo "$PROV_JSON" | jq -e '.ok == true' >/dev/null 2>&1; then
  pass "provision ok"
else
  fail "provision failed"
fi

step "2/5 Rotate slug secret again (idempotent check)"
ROT_JSON=$(curl -sS -X POST "https://${API}/sandbox/admin/secrets/rotate" \
  -H "x-sandbox-secret: ${SECRET}" -H "content-type: application/json" \
  --max-time 15 -d "$(jq -nc --arg s "$SLUG" '{slug:$s}')") || true
echo "$ROT_JSON" | jq . 2>/dev/null || echo "$ROT_JSON"
if echo "$ROT_JSON" | jq -e '.ok == true' >/dev/null 2>&1; then
  pass "rotate ok (version=$(echo "$ROT_JSON" | jq -r '.version // "?"'))"
else
  fail "rotate failed"
fi

step "3/5 Verify secret status"
ST_JSON=$(curl -sS "https://${API}/sandbox/admin/secrets/status?slug=${SLUG}" \
  -H "x-sandbox-secret: ${SECRET}" --max-time 10) || true
echo "$ST_JSON" | jq . 2>/dev/null || echo "$ST_JSON"
echo "$ST_JSON" | jq -e '.ok == true and .active == true' >/dev/null 2>&1 \
  && pass "secret active" || fail "secret status not active"

step "4/5 HTTPS probe ($URL) — expect 2xx/3xx"
# Retry up to 6 times to allow DNS/nginx to settle.
CODE=000
for i in 1 2 3 4 5 6; do
  CODE=$(curl -sS -o /tmp/_smoke_body -w '%{http_code}' -L --max-time 15 "$URL" || echo 000)
  case "$CODE" in
    2*|3*) break ;;
  esac
  sleep 3
done
echo "  HTTP $CODE"
case "$CODE" in
  2*|3*) pass "HTTPS reachable ($CODE)" ;;
  *) fail "HTTPS probe returned $CODE" ;;
esac

step "5/5 SSL certificate validity for $HOST"
CERT_INFO=$(echo | openssl s_client -servername "$HOST" -connect "${HOST}:443" 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates 2>/dev/null || true)
if [ -z "$CERT_INFO" ]; then
  fail "could not read certificate"
else
  echo "$CERT_INFO" | sed 's/^/  /'
  END=$(echo "$CERT_INFO" | awk -F= '/notAfter/{print $2}')
  if [ -n "$END" ]; then
    END_EPOCH=$(date -d "$END" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    DAYS=$(( (END_EPOCH - NOW_EPOCH) / 86400 ))
    if [ "$DAYS" -gt 0 ]; then
      pass "cert valid, expires in ${DAYS}d"
      [ "$DAYS" -lt 30 ] && echo "  ⚠ expires within 30 days"
    else
      fail "cert expired ($DAYS days)"
    fi
  fi
fi

echo
echo "════════════════════════════════════════════════"
if [ "$FAILED" = "0" ]; then
  echo "✅ Smoke passed: $URL"
  exit 0
else
  echo "❌ Smoke failed for: $URL"
  exit 1
fi
