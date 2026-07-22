#!/usr/bin/env bash
# smoke-cutover.sh
# ---------------------------------------------------------------
# End-to-end cutover smoke test:
#   1. Scans a dist/ dir (or a live URL) for supabase.co URLs
#   2. Probes Pluto /health with /readyz and /healthz fallbacks
#   3. Probes Pluto /auth/v1/settings
#   4. Optionally verifies a real authenticated session with /auth/v1/user
#   5. Prints ONE-LINE status: CUTOVER=OK|FAIL <reasons>
#
# Usage:
#   bash smoke-cutover.sh [--dist ./dist] [--url https://app.timescard.cloud] \
#                        [--api https://api.timescard.cloud] \
#                        [--auth-token <jwt> | --email <e> --password <p>]
#
# Env fallbacks: DIST, SITE_URL, PLUTO_API, SMOKE_AUTH_TOKEN,
#                SMOKE_AUTH_EMAIL, SMOKE_AUTH_PASSWORD, REQUIRE_AUTH_SMOKE=1
set -euo pipefail

DIST="${DIST:-}"
SITE_URL="${SITE_URL:-}"
PLUTO_API="${PLUTO_API:-https://api.timescard.cloud}"
AUTH_TOKEN="${SMOKE_AUTH_TOKEN:-${PLUTO_AUTH_ACCESS_TOKEN:-}}"
AUTH_EMAIL="${SMOKE_AUTH_EMAIL:-${PLUTO_TEST_EMAIL:-}}"
AUTH_PASSWORD="${SMOKE_AUTH_PASSWORD:-${PLUTO_TEST_PASSWORD:-}}"
REQUIRE_AUTH_SMOKE="${REQUIRE_AUTH_SMOKE:-0}"
AUTH_STATUS="skip"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dist) DIST="$2"; shift 2;;
    --url)  SITE_URL="$2"; shift 2;;
    --api)  PLUTO_API="$2"; shift 2;;
    --auth-token) AUTH_TOKEN="$2"; shift 2;;
    --email) AUTH_EMAIL="$2"; shift 2;;
    --password) AUTH_PASSWORD="$2"; shift 2;;
    --require-auth) REQUIRE_AUTH_SMOKE=1; shift;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[[ -n "$DIST" || -n "$SITE_URL" ]] || DIST="dist"

REASONS=()
FAIL=0

env_file_has_pluto_key() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  python3 - "$file" <<'PY'
import re
import sys

path = sys.argv[1]
try:
    text = open(path, "r", encoding="utf-8", errors="ignore").read()
except OSError:
    raise SystemExit(1)

values = [m.group(2).strip() for m in re.finditer(r"\b(?:anonKey|VITE_PLUTO_ANON_KEY)\s*:\s*(['\"])(.*?)\1", text)]
bad = {"", "pk_anon_REPLACE_ME", "REPLACE_ME", "CHANGE_ME", "YOUR_KEY", "YOUR_ANON_KEY"}
for value in values:
    lower = value.lower()
    if value not in bad and "..." not in value and "…" not in value and "replace_me" not in lower and "your_" not in lower and not re.fullmatch(r"pk_?x+", lower):
        raise SystemExit(0)
raise SystemExit(1)
PY
}

scan_dir() {
  local d="$1"
  [[ -d "$d" ]] || { REASONS+=("dist:$d missing"); FAIL=1; return; }
  if grep -RIlq -E 'https?://[a-z0-9-]+\.supabase\.(co|in)' "$d" 2>/dev/null; then
    REASONS+=("supabase-url-in-dist")
    FAIL=1
  fi
  if [[ ! -f "$d/env.js" ]] || ! grep -q 'VITE_PLUTO_URL' "$d/env.js" 2>/dev/null; then
    REASONS+=("env.js-missing-or-empty")
    FAIL=1
  elif ! env_file_has_pluto_key "$d/env.js"; then
    REASONS+=("env.js-pluto-anon-key-missing")
    FAIL=1
  elif grep -q 'pk_anon_REPLACE_ME' "$d/env.js" 2>/dev/null; then
    REASONS+=("env.js-placeholder-anon-key")
    FAIL=1
  fi
}

probe_health() {
  local path code
  HEALTH_PATH=""
  HEALTH_STATUS="000"
  for path in /health /readyz /healthz; do
    code="$(curl -s -o /tmp/pluto-health.$$ -w '%{http_code}' --max-time 5 "$PLUTO_API$path" || echo 000)"
    rm -f /tmp/pluto-health.$$
    if [[ "$code" =~ ^2 ]]; then
      HEALTH_PATH="$path"
      HEALTH_STATUS="$code"
      return 0
    fi
    [[ "$HEALTH_STATUS" = "000" ]] && HEALTH_STATUS="$code"
  done
  REASONS+=("pluto-health-$HEALTH_STATUS")
  FAIL=1
}

scan_url() {
  local base="$1" tmp
  tmp="$(mktemp -d)"
  trap "rm -rf $tmp" RETURN
  curl -sSL --max-time 10 -H 'cache-control: no-cache' "$base/?pluto_smoke=$(date +%s)" -o "$tmp/index.html" 2>/dev/null || { REASONS+=("site-unreachable"); FAIL=1; return; }
  mapfile -t ASSETS < <(grep -oE '/assets/[A-Za-z0-9._/-]+\.js' "$tmp/index.html" | sort -u | head -20)
  for a in "${ASSETS[@]}"; do curl -sSL --max-time 10 -H 'cache-control: no-cache' "$base$a" >> "$tmp/all.js" 2>/dev/null || true; done
  curl -sSL --max-time 5 -H 'cache-control: no-cache' "$base/env.js?pluto_smoke=$(date +%s)" -o "$tmp/env.js" 2>/dev/null || true
  cat "$tmp/index.html" "$tmp/all.js" "$tmp/env.js" > "$tmp/all.txt" 2>/dev/null || true
  if grep -qE 'https?://[a-z0-9-]+\.supabase\.(co|in)' "$tmp/all.txt" 2>/dev/null; then
    REASONS+=("supabase-url-in-live-bundle"); FAIL=1
  fi
  if ! grep -qE 'api\.timescard\.cloud|VITE_PLUTO_URL' "$tmp/all.txt" 2>/dev/null; then
    REASONS+=("pluto-url-missing-in-live-bundle"); FAIL=1
  fi
  if ! env_file_has_pluto_key "$tmp/env.js"; then
    REASONS+=("pluto-anon-key-missing-in-live-bundle"); FAIL=1
  fi
}

json_get_access_token() {
  python3 -c 'import json,sys; print((json.load(sys.stdin) or {}).get("access_token", ""))' 2>/dev/null || true
}

json_token_payload() {
  AUTH_EMAIL_PAYLOAD="$AUTH_EMAIL" AUTH_PASSWORD_PAYLOAD="$AUTH_PASSWORD" python3 - <<'PY'
import json, os
print(json.dumps({
  "grant_type": "password",
  "email": os.environ.get("AUTH_EMAIL_PAYLOAD", ""),
  "password": os.environ.get("AUTH_PASSWORD_PAYLOAD", ""),
}))
PY
}

probe_auth_session() {
  local token_body token user_code token_code unauth_code

  if [[ -z "$AUTH_TOKEN" && -n "$AUTH_EMAIL" && -n "$AUTH_PASSWORD" ]]; then
    token_body="$(mktemp)"
    token_code="$(curl -sS -o "$token_body" -w '%{http_code}' --max-time 10 \
      -X POST "$PLUTO_API/auth/v1/token?grant_type=password" \
      -H 'content-type: application/json' \
      --data "$(json_token_payload)" || echo 000)"
    if [[ "$token_code" =~ ^2 ]]; then
      AUTH_TOKEN="$(json_get_access_token < "$token_body")"
    else
      REASONS+=("pluto-auth-token-$token_code"); FAIL=1; AUTH_STATUS="token-$token_code"
      rm -f "$token_body"
      return
    fi
    rm -f "$token_body"
  fi

  if [[ -n "$AUTH_TOKEN" ]]; then
    user_code="$(curl -s -o /tmp/pluto-auth-user.$$ -w '%{http_code}' --max-time 10 \
      -H "authorization: Bearer ${AUTH_TOKEN}" "$PLUTO_API/auth/v1/user" || echo 000)"
    rm -f /tmp/pluto-auth-user.$$
    if [[ "$user_code" =~ ^2 ]]; then
      AUTH_STATUS="ok"
    else
      REASONS+=("pluto-auth-user-$user_code"); FAIL=1; AUTH_STATUS="user-$user_code"
    fi
    return
  fi

  unauth_code="$(curl -s -o /tmp/pluto-auth-unauth.$$ -w '%{http_code}' --max-time 8 \
    "$PLUTO_API/auth/v1/user" || echo 000)"
  rm -f /tmp/pluto-auth-unauth.$$
  if [[ "$unauth_code" = "401" ]]; then
    AUTH_STATUS="guard-401"
    if [[ "$REQUIRE_AUTH_SMOKE" = "1" ]]; then
      REASONS+=("auth-credentials-missing"); FAIL=1
    fi
  else
    REASONS+=("auth-user-guard-$unauth_code"); FAIL=1; AUTH_STATUS="guard-$unauth_code"
  fi
}

[[ -n "$DIST"     ]] && scan_dir "$DIST"
[[ -n "$SITE_URL" ]] && scan_url "$SITE_URL"

# API probes
probe_health

settings="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$PLUTO_API/auth/v1/settings" || echo 000)"
[[ "$settings" =~ ^[23] ]] || { REASONS+=("pluto-auth-settings-$settings"); FAIL=1; }

probe_auth_session

if [[ $FAIL -eq 0 ]]; then
  echo "CUTOVER=OK dist=${DIST:-skip} site=${SITE_URL:-skip} api=$PLUTO_API health=${HEALTH_PATH:-?}:$HEALTH_STATUS settings=$settings auth=$AUTH_STATUS"
  exit 0
else
  IFS=,; echo "CUTOVER=FAIL reasons=${REASONS[*]} api=$PLUTO_API health=${HEALTH_PATH:-?}:$HEALTH_STATUS settings=$settings auth=$AUTH_STATUS"
  exit 1
fi
