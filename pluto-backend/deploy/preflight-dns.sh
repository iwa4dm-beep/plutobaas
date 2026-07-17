#!/usr/bin/env bash
# preflight-dns.sh — verify DNS + HTTP-01 reachability for a slug before certbot.
#
# Usage:
#   sudo bash pluto-backend/deploy/preflight-dns.sh <slug> [base]
#     base defaults to app.timescard.cloud
#
# Exit codes:
#   0  everything green (either exact A or covered by wildcard)
#   10 DNS record missing (prints exact record to add at the registrar)
#   11 DNS points at a different IP than this VPS
#   12 HTTP-01 self-challenge failed (port 80 blocked / nginx / firewall / proxy)
#   20 dependency missing (dig/curl)
#
# Also PRINTS which certbot flow to use based on the zone's nameservers:
#   * NS at Cloudflare  → DNS-01 (wildcard-friendly)
#   * everywhere else   → HTTP-01 per-slug (works from any registrar)

set -uo pipefail
SLUG="${1:-}"
BASE="${2:-app.timescard.cloud}"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yell()  { printf "\033[33m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

if [[ -z "$SLUG" ]]; then
  red "usage: preflight-dns.sh <slug> [base]"
  exit 2
fi
if ! [[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  red "✗ invalid slug '$SLUG' (must be DNS-label safe)"
  exit 2
fi

for bin in dig curl awk; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    red "✗ missing dependency: $bin (apt install dnsutils curl gawk)"
    exit 20
  fi
done

FQDN="${SLUG}.${BASE}"
WILDCARD_LABEL="*.${BASE#*.}"   # wildcard host for the base zone segment
ZONE_ROOT="${BASE#*.}"          # e.g. app.timescard.cloud → timescard.cloud
WEBROOT="/var/www/certbot"

bold "▸ Preflight for ${FQDN}"
echo  "  zone root: ${ZONE_ROOT}"

# ── 1. VPS public IP ─────────────────────────────────────────────────────────
public_ip() {
  for src in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
    ip="$(curl -fsS --max-time 3 "$src" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$ip" =~ ^[0-9.]+$ ]] && { echo "$ip"; return; }
  done
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
}
VPS_IP="$(public_ip || true)"
[[ -n "$VPS_IP" ]] && green "  VPS IPv4:  ${VPS_IP}" || yell "  VPS IPv4:  <unknown>"

# ── 2. Nameserver detection → suggest ACME challenge ────────────────────────
NS_LIST="$(dig +short NS "$ZONE_ROOT" @1.1.1.1 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed 's/\.$//' | sort -u | tr '\n' ' ' | sed 's/ $//')"
if [[ -z "$NS_LIST" ]]; then
  yell "  Nameservers: <not resolvable> — zone may be misconfigured"
  NS_PROVIDER="unknown"
elif echo "$NS_LIST" | grep -qE '(^| )[a-z0-9-]+\.ns\.cloudflare\.com'; then
  NS_PROVIDER="cloudflare"
elif echo "$NS_LIST" | grep -qE 'dns-parking\.com|hostinger'; then
  NS_PROVIDER="hostinger"
elif echo "$NS_LIST" | grep -qE 'awsdns'; then
  NS_PROVIDER="route53"
elif echo "$NS_LIST" | grep -qE 'domaincontrol\.com'; then
  NS_PROVIDER="godaddy"
elif echo "$NS_LIST" | grep -qE 'namecheap|registrar-servers'; then
  NS_PROVIDER="namecheap"
else
  NS_PROVIDER="other"
fi
echo  "  Nameservers: ${NS_LIST:-none}"
echo  "  Provider:    ${NS_PROVIDER}"

case "$NS_PROVIDER" in
  cloudflare)
    green "  ✓ Recommended ACME: DNS-01 wildcard (fewer per-slug certs, needs CF_API_TOKEN)"
    RECOMMEND="dns01" ;;
  *)
    green "  ✓ Recommended ACME: HTTP-01 per-slug (works from any registrar, no API token)"
    RECOMMEND="http01" ;;
esac

# ── 3. A record for FQDN (or wildcard) ──────────────────────────────────────
A_EXACT="$(dig +short A "$FQDN" @1.1.1.1 | grep -E '^[0-9.]+$' | head -n1 || true)"
A_WILD="$(dig +short A "test-$(date +%s).${BASE}" @1.1.1.1 | grep -E '^[0-9.]+$' | head -n1 || true)"
RESOLVED=""
if [[ -n "$A_EXACT" ]]; then
  RESOLVED="$A_EXACT"; SRC="exact A record"
elif [[ -n "$A_WILD" ]]; then
  RESOLVED="$A_WILD";  SRC="wildcard A record"
fi

if [[ -z "$RESOLVED" ]]; then
  red "✗ DNS: no A record resolves for ${FQDN}"
  cat <<MSG

  Add ONE of these at your registrar's DNS panel (${NS_PROVIDER}):

    Option A — per-slug (this slug only):
      Type: A     Name: ${SLUG}.${BASE%%.*}     Value: ${VPS_IP:-<VPS-IPv4>}     TTL: 300

    Option B — wildcard (covers every future slug, RECOMMENDED):
      Type: A     Name: *.${BASE%%.*}           Value: ${VPS_IP:-<VPS-IPv4>}     TTL: 300

  Then wait ~60s for propagation and rerun this preflight.
MSG
  exit 10
fi
green "  ✓ DNS: ${FQDN} → ${RESOLVED} (via ${SRC})"

if [[ -n "$VPS_IP" && "$RESOLVED" != "$VPS_IP" ]]; then
  red "✗ DNS mismatch — ${FQDN} points to ${RESOLVED}, not this VPS (${VPS_IP})"
  cat <<MSG

  Update the A record value at ${NS_PROVIDER} to: ${VPS_IP}
  (If you use Cloudflare, also set the record to DNS-only / grey-cloud so
   HTTP-01 challenge can reach this VPS directly.)
MSG
  exit 11
fi

# ── 4. HTTP-01 self-probe on port 80 ────────────────────────────────────────
# Make the preflight useful on a fresh VPS: if nginx has no :80 ACME vhost for
# this slug yet, install a temporary one before probing. Also quarantine stale
# managed Pluto configs that can make nginx -t fail before HTTP-01 even starts.
if [[ "$(id -u)" == "0" ]]; then
  mkdir -p "${WEBROOT}/.well-known/acme-challenge" 2>/dev/null || true

  OLD_SLUG_LINK="/etc/nginx/sites-enabled/pluto-slug-${SLUG}.conf"
  if [[ -e "$OLD_SLUG_LINK" ]] && nginx -t 2>&1 | grep -q 'unknown log format "pluto_slug_json"'; then
    yell "  ! disabling stale per-slug vhost with missing log_format: $OLD_SLUG_LINK"
    rm -f "$OLD_SLUG_LINK"
  fi

  WILDCARD_LINK="/etc/nginx/sites-enabled/pluto-wildcard-${BASE}.conf"
  WILDCARD_CERT="/etc/letsencrypt/live/${BASE}/fullchain.pem"
  if [[ -e "$WILDCARD_LINK" ]]; then
    if [[ ! -s "$WILDCARD_CERT" ]] || ! openssl x509 -in "$WILDCARD_CERT" -noout -text 2>/dev/null | grep -q "DNS:\*\.${BASE}"; then
      yell "  ! disabling incomplete wildcard vhost while testing HTTP-01: $WILDCARD_LINK"
      rm -f "$WILDCARD_LINK"
    fi
  fi

  if ! nginx -T 2>/dev/null | grep -qE "server_name[[:space:]]+.*${FQDN//./\.}"; then
    STUB="/etc/nginx/sites-available/pluto-slug-${SLUG}-acme.conf"
    cat > "$STUB" <<CONF
server {
    listen 80;
    listen [::]:80;
    server_name ${FQDN};
    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    location / { return 404; }
}
CONF
    ln -sf "$STUB" "/etc/nginx/sites-enabled/pluto-slug-${SLUG}-acme.conf"
    if nginx -t >/tmp/pluto-preflight-nginx.out 2>&1; then
      systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null || true
      green "  ✓ temporary HTTP-01 nginx stub installed"
    else
      red "✗ nginx config is invalid before HTTP-01 probe"
      cat /tmp/pluto-preflight-nginx.out
      cat <<MSG

  Diagnose:
    sudo bash pluto-backend/deploy/diagnose-cert-failure.sh ${SLUG} ${BASE}
MSG
      exit 12
    fi
  fi
else
  yell "  ! not root — cannot install temporary nginx ACME stub; probing existing config only"
fi

TOKEN="preflight-$(date +%s)-$$"
echo "$TOKEN" > "${WEBROOT}/.well-known/acme-challenge/${TOKEN}" 2>/dev/null || true

PROBE_CODE="$(curl -fsS -o /tmp/preflight-probe.out -w '%{http_code}' \
              --max-time 6 "http://${FQDN}/.well-known/acme-challenge/${TOKEN}" || echo "000")"
PROBE_BODY="$(cat /tmp/preflight-probe.out 2>/dev/null || true)"
rm -f "${WEBROOT}/.well-known/acme-challenge/${TOKEN}" /tmp/preflight-probe.out

if [[ "$PROBE_CODE" == "200" && "$PROBE_BODY" == "$TOKEN" ]]; then
  green "  ✓ HTTP-01 reachable: http://${FQDN}/.well-known/acme-challenge/ returns 200"
else
  red "✗ HTTP-01 self-probe failed (HTTP ${PROBE_CODE})"
  cat <<MSG

  Root-cause suspects (fix ONE of):
    1. Firewall blocks 80:   sudo ufw allow 80/tcp && sudo ufw reload
    2. Nginx not serving webroot for ${FQDN}:
       sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG} ${BASE}
       (this script writes the stub vhost that answers /.well-known/acme-challenge)
    3. Cloudflare in orange-cloud proxy mode — grey the cloud for ${FQDN}.
    4. Reverse proxy in front of this VPS is stripping /.well-known/…
    5. nginx test/reload broken:   sudo nginx -t && sudo systemctl reload nginx

MSG
  exit 12
fi

# ── 5. Summary ──────────────────────────────────────────────────────────────
echo
bold "✓ Preflight passed."
case "$RECOMMEND" in
  dns01)
    cat <<MSG
  Next: DNS-01 wildcard (Cloudflare)
    CF_API_TOKEN='<token>' CF_ZONE_ID='<zone-id>' \\
      sudo -E bash pluto-backend/deploy/install-wildcard-tls.sh
MSG
    ;;
  http01)
    cat <<MSG
  Next: HTTP-01 per-slug (no registrar API needed)
    sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG} ${BASE}
MSG
    ;;
esac
exit 0
