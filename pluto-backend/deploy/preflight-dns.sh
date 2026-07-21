#!/usr/bin/env bash
# preflight-dns.sh — verify DNS + HTTP-01 reachability for a slug before certbot.
#
# Usage:
#   sudo bash pluto-backend/deploy/preflight-dns.sh <slug> [base]
#     base defaults to app.timescard.app
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
BASE="${2:-app.timescard.app}"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yell()  { printf "\033[33m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

quarantine_nginx_blockers() {
  # Old Pluto vhosts can keep nginx -t broken before this script gets a chance
  # to install the temporary HTTP-01 server block. Disable only managed Pluto
  # links/configs that match known stale signatures, then let the deploy flow
  # regenerate them from the current templates.
  [[ "$(id -u)" == "0" ]] || return 0

  local changed=0 out bad_config link target
  local quarantine_dir="/etc/nginx/sites-enabled/.pluto-disabled-$(date +%Y%m%d-%H%M%S)"

  for _ in 1 2 3 4 5; do
    out="$(nginx -t 2>&1 || true)"
    grep -qE 'unknown log format "pluto_slug_json"|cannot load certificate|no such file or directory.*fullchain.pem' <<<"$out" || break

    if grep -q 'unknown log format "pluto_slug_json"' <<<"$out"; then
      # Prefer the exact config path reported by nginx, then also catch any
      # enabled managed Pluto vhost that still references the old log_format.
      while IFS= read -r bad_config; do
        [[ -z "$bad_config" ]] && continue
        mkdir -p "$quarantine_dir"
        if [[ "$bad_config" == /etc/nginx/sites-enabled/pluto-*.conf ]]; then
          yell "  ! disabling stale Pluto vhost with missing log_format: $bad_config"
          mv -f "$bad_config" "$quarantine_dir/$(basename "$bad_config")" 2>/dev/null || rm -f "$bad_config"
          changed=1
        fi
      done < <(grep -oE '/etc/nginx/sites-enabled/pluto-[^: ]+\.conf' <<<"$out" | sort -u)

      for link in /etc/nginx/sites-enabled/pluto-*.conf; do
        [[ -e "$link" || -L "$link" ]] || continue
        target="$link"
        [[ -L "$link" ]] && target="$(readlink -f "$link" 2>/dev/null || echo "$link")"
        if grep -q 'pluto_slug_json' "$target" 2>/dev/null; then
          mkdir -p "$quarantine_dir"
          yell "  ! disabling stale Pluto vhost with missing log_format: $link"
          mv -f "$link" "$quarantine_dir/$(basename "$link")" 2>/dev/null || rm -f "$link"
          changed=1
        fi
      done
    fi

    # Broken cert references from old managed per-slug/wildcard vhosts should
    # not block a fresh HTTP-01 cert. Remove only Pluto-managed enabled links.
    while IFS= read -r bad_config; do
      [[ -z "$bad_config" ]] && continue
      if [[ "$bad_config" == /etc/nginx/sites-enabled/pluto-*.conf ]]; then
        mkdir -p "$quarantine_dir"
        yell "  ! disabling Pluto vhost with missing cert reference: $bad_config"
        mv -f "$bad_config" "$quarantine_dir/$(basename "$bad_config")" 2>/dev/null || rm -f "$bad_config"
        changed=1
      fi
    done < <(grep -oE '/etc/nginx/sites-enabled/pluto-[^: ]+\.conf' <<<"$out" | sort -u)
  done

  [[ "$changed" -eq 1 ]] && yell "  ! disabled stale nginx configs are backed up in: $quarantine_dir"
  return 0
}

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
ZONE_ROOT="${BASE#*.}"          # e.g. app.timescard.app → timescard.app
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

public_ipv6() {
  local ip=""
  ip="$(curl -6 -fsS --max-time 3 https://api64.ipify.org 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$ip" == *:* ]] && { echo "$ip"; return; }
  ip -6 route get 2606:4700:4700::1111 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
}
VPS_IPV6="$(public_ipv6 || true)"
[[ -n "$VPS_IPV6" ]] && echo "  VPS IPv6:  ${VPS_IPV6}" || yell "  VPS IPv6:  <none detected>"

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

# Let's Encrypt may prefer IPv6 when an AAAA record exists. If AAAA points to
# another host, local IPv4 curl tests pass but certbot still fails HTTP-01.
AAAA_EXACT="$(dig +short AAAA "$FQDN" @1.1.1.1 | grep -E ':' | tr '\n' ' ' || true)"
AAAA_WILD="$(dig +short AAAA "test-$(date +%s).${BASE}" @1.1.1.1 | grep -E ':' | tr '\n' ' ' || true)"
AAAA_RESOLVED="${AAAA_EXACT:-$AAAA_WILD}"
if [[ -n "$AAAA_RESOLVED" ]]; then
  echo "  AAAA:      ${AAAA_RESOLVED}"
  IPV6_MATCH=0
  if [[ -n "$VPS_IPV6" ]]; then
    for ip6 in $AAAA_RESOLVED; do [[ "$ip6" == "$VPS_IPV6" ]] && IPV6_MATCH=1; done
  fi
  if [[ "$IPV6_MATCH" -ne 1 ]]; then
    red "✗ IPv6/AAAA mismatch — ${FQDN} has AAAA record(s) not pointing to this VPS"
    cat <<MSG

  DNS AAAA value(s): ${AAAA_RESOLVED}
  This VPS IPv6:     ${VPS_IPV6:-<none detected>}

  Fix at ${NS_PROVIDER} before certbot:
    • Recommended: delete the AAAA record for ${FQDN} and any wildcard AAAA for *.${BASE}
    • Or point AAAA to this VPS IPv6 and open port 80 on IPv6.

  Keep this A record:
    Type: A     Name: ${SLUG}.${BASE%%.*}     Value: ${VPS_IP:-<VPS-IPv4>}
MSG
    exit 11
  fi
  green "  ✓ AAAA also points at this VPS"
fi

# ── 4. HTTP-01 self-probe on port 80 ────────────────────────────────────────
# Make the preflight useful on a fresh VPS: if nginx has no :80 ACME vhost for
# this slug yet, install a temporary one before probing. Also quarantine stale
# managed Pluto configs that can make nginx -t fail before HTTP-01 even starts.
if [[ "$(id -u)" == "0" ]]; then
  mkdir -p "${WEBROOT}/.well-known/acme-challenge" 2>/dev/null || true
  quarantine_nginx_blockers

  OLD_SLUG_LINK="/etc/nginx/sites-enabled/pluto-slug-${SLUG}.conf"
  if [[ -e "$OLD_SLUG_LINK" || -L "$OLD_SLUG_LINK" ]] && nginx -t 2>&1 | grep -q 'unknown log format "pluto_slug_json"'; then
    yell "  ! disabling stale per-slug vhost with missing log_format: $OLD_SLUG_LINK"
    rm -f "$OLD_SLUG_LINK"
  fi

  WILDCARD_LINK="/etc/nginx/sites-enabled/pluto-wildcard-${BASE}.conf"
  WILDCARD_CERT="/etc/letsencrypt/live/${BASE}/fullchain.pem"
  if [[ -e "$WILDCARD_LINK" || -L "$WILDCARD_LINK" ]]; then
    if [[ ! -s "$WILDCARD_CERT" ]] || ! openssl x509 -in "$WILDCARD_CERT" -noout -text 2>/dev/null | grep -q "DNS:\*\.${BASE}"; then
      yell "  ! disabling incomplete wildcard vhost while testing HTTP-01: $WILDCARD_LINK"
      rm -f "$WILDCARD_LINK"
    fi
  fi
  quarantine_nginx_blockers

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
