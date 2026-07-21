#!/usr/bin/env bash
# ensure-wildcard-dns.sh — make project subdomains resolve to this VPS.
#
# Fixes curl HTTP 000 / "Could not resolve host" for:
#   https://<slug>.<apex>/
#   https://<slug>-dev.<apex>/
#
# If Cloudflare DNS credentials are present at /etc/letsencrypt/cloudflare.ini,
# this script upserts:
#   <apex>       A  <this-vps-public-ip>
#   *.<apex>     A  <this-vps-public-ip>
# Otherwise it prints the exact manual DNS records to add.
#
# Usage:
#   sudo bash deploy/ensure-wildcard-dns.sh app.timescard.cloud
#   sudo VPS_IP=185.158.133.1 bash deploy/ensure-wildcard-dns.sh app.timescard.cloud

set -euo pipefail

APEX="${1:-${WILDCARD:-app.timescard.cloud}}"
CF_INI="${CF_INI:-/etc/letsencrypt/cloudflare.ini}"
CF_ZONE_ID="${CF_ZONE_ID:-}"
CF_PROXY="${CF_PROXY:-false}"
TTL="${TTL:-120}"

log(){ printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

public_ip() {
  if [ -n "${VPS_IP:-}" ]; then printf '%s' "$VPS_IP"; return 0; fi
  curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null \
    || curl -4fsS --max-time 8 https://ifconfig.me 2>/dev/null \
    || true
}

IP="$(public_ip)"
echo "$IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "Could not detect this VPS public IPv4. Re-run with VPS_IP='<server-ip>'."

TOKEN="${CF_API_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$CF_INI" ]; then
  TOKEN="$(awk -F= '/dns_cloudflare_api_token[[:space:]]*=/{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}' "$CF_INI" 2>/dev/null || true)"
fi

manual_records() {
  cat <<EOF
Add these DNS records at the DNS provider for ${APEX#*.}:

  Type  Name        Value       Proxy
  A     ${APEX}     ${IP}       DNS-only
  A     *.${APEX}   ${IP}       DNS-only

Then wait a minute and verify:
  getent hosts dbhstock-8myjt4.${APEX}
  curl -I https://dbhstock-8myjt4.${APEX}/
EOF
}

if [ -z "$TOKEN" ]; then
  warn "No Cloudflare API token found at $CF_INI; DNS cannot be changed automatically."
  manual_records
  exit 0
fi

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS --max-time 20 -X "$method" "https://api.cloudflare.com/client/v4${path}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -fsS --max-time 20 -X "$method" "https://api.cloudflare.com/client/v4${path}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json"
  fi
}

find_zone_id() {
  if [ -n "$CF_ZONE_ID" ]; then printf '%s' "$CF_ZONE_ID"; return 0; fi
  python3 - "$APEX" <<'PY'
import sys
apex=sys.argv[1].strip('.')
parts=apex.split('.')
for i in range(0, max(len(parts)-1, 1)):
    print('.'.join(parts[i:]))
PY
}

ZONE_ID=""
ZONE_NAME=""
while read -r candidate; do
  [ -n "$candidate" ] || continue
  body="$(api GET "/zones?name=${candidate}&status=active" 2>/dev/null || true)"
  parsed="$(python3 -c 'import json,sys
try:
    j=json.loads(sys.argv[1] or "{}")
    r=(j.get("result") or [])
    if r:
        print((r[0].get("id") or "") + " " + (r[0].get("name") or ""))
except Exception:
    pass' "$body" 2>/dev/null || true)"
  if [ -n "$parsed" ]; then
    ZONE_ID="${parsed%% *}"
    ZONE_NAME="${parsed#* }"
    break
  fi
done < <(find_zone_id)

[ -n "$ZONE_ID" ] || {
  warn "Cloudflare token is present, but the zone for $APEX was not discoverable."
  echo "If your token has no Zone:Read permission, re-run with CF_ZONE_ID='<zone-id>'."
  manual_records
  exit 0
}

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

upsert_a_record() {
  local name="$1" record_id existing proxied payload list
  list="$(api GET "/zones/${ZONE_ID}/dns_records?type=A&name=${name}" 2>/dev/null || true)"
  existing="$(python3 -c 'import json,sys
try:
    j=json.loads(sys.argv[1] or "{}")
    r=(j.get("result") or [])
    if r:
        x=r[0]
        print((x.get("id") or "") + " " + (x.get("content") or "") + " " + str(x.get("proxied", False)).lower())
except Exception:
    pass' "$list" 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    record_id="$(printf '%s' "$existing" | awk '{print $1}')"
    proxied="$(printf '%s' "$existing" | awk '{print $3}')"
    [ -n "$proxied" ] || proxied="$CF_PROXY"
    payload="{\"type\":\"A\",\"name\":$(json_escape "$name"),\"content\":$(json_escape "$IP"),\"ttl\":${TTL},\"proxied\":${proxied}}"
    api PUT "/zones/${ZONE_ID}/dns_records/${record_id}" "$payload" >/dev/null
    echo "  ✓ updated A ${name} → ${IP}"
  else
    payload="{\"type\":\"A\",\"name\":$(json_escape "$name"),\"content\":$(json_escape "$IP"),\"ttl\":${TTL},\"proxied\":${CF_PROXY}}"
    api POST "/zones/${ZONE_ID}/dns_records" "$payload" >/dev/null
    echo "  ✓ created A ${name} → ${IP}"
  fi
}

log "Ensuring wildcard DNS for ${APEX} in Cloudflare zone ${ZONE_NAME:-$ZONE_ID}"
upsert_a_record "$APEX"
upsert_a_record "*.${APEX}"

echo
echo "✓ DNS repair requested. It can take 30–120 seconds to propagate."
echo "  Test: getent hosts dbhstock-8myjt4.${APEX}"