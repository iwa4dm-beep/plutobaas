#!/usr/bin/env bash
# Issue an HTTP-01 (webroot) Let's Encrypt certificate for a single Pluto slug
# subdomain and install a dedicated nginx vhost for it. Use this when the base
# domain (default: app.timescard.cloud) is NOT on Cloudflare / a DNS provider
# supported by certbot, so wildcard DNS-01 isn't available.
#
# Usage:
#   sudo bash pluto-backend/deploy/issue-per-slug-cert.sh <slug> [base-domain] [admin-email]
#
# Example:
#   sudo bash pluto-backend/deploy/issue-per-slug-cert.sh dubaiborkahouse-tzsegx
#
# Prereqs (verified by this script):
#   * DNS A record <slug>.<base> → this VPS's public IP (works for *.<base> too)
#   * nginx listening on :80 and /var/www/certbot writable
#   * certbot installed (apt install -y certbot python3-certbot-nginx)
#   * /var/lib/pluto/sites/<slug>/current exists (created by the sandbox worker
#     after a successful deploy; we don't require a bundle here — nginx will
#     show "Not deployed yet" until one is uploaded).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

SLUG="${1:-}"
BASE="${2:-app.timescard.cloud}"
EMAIL="${3:-${CERT_EMAIL:-admin@timescard.cloud}}"

if [[ -z "$SLUG" ]]; then
  echo "Usage: $0 <slug> [base-domain] [admin-email]" >&2
  exit 2
fi
if ! [[ "$SLUG" =~ ^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$ ]] 2>/dev/null; then
  # bash regex doesn't support (?:) — do a plain check.
  if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$ ]]; then
    echo "Invalid slug: $SLUG" >&2
    exit 2
  fi
fi

FQDN="${SLUG}.${BASE}"
WEBROOT="/var/www/certbot"
SITE_ROOT="/var/lib/pluto/sites/${SLUG}"
NGINX_AVAILABLE="/etc/nginx/sites-available/pluto-slug-${SLUG}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/pluto-slug-${SLUG}.conf"
TEMPLATE="$(cd "$(dirname "$0")" && pwd)/nginx/per-slug-http01.conf.template"

echo "==> Issuing HTTP-01 cert for ${FQDN}"

# Previous failed runs may have left an enabled per-slug vhost rendered by an
# older template (for example referencing an unavailable log_format). Remove it
# before the pre-cert nginx -t; the final, fresh vhost is rendered again below.
rm -f "$NGINX_ENABLED"

# If a managed wildcard vhost was enabled without a usable wildcard cert, nginx
# -t fails before this per-slug flow can complete. Quarantine only the managed
# Pluto wildcard link; per-slug vhosts do not need it.
WILDCARD_LINK="/etc/nginx/sites-enabled/pluto-wildcard-${BASE}.conf"
WILDCARD_CERT="/etc/letsencrypt/live/${BASE}/fullchain.pem"
if [[ -e "$WILDCARD_LINK" ]]; then
  if [[ ! -s "$WILDCARD_CERT" ]] || ! openssl x509 -in "$WILDCARD_CERT" -noout -text 2>/dev/null | grep -q "DNS:\*\.${BASE}"; then
    echo "==> Disabling incomplete wildcard vhost while issuing per-slug cert: $WILDCARD_LINK"
    rm -f "$WILDCARD_LINK"
  fi
fi

# 1) Ensure certbot is present
if ! command -v certbot >/dev/null 2>&1; then
  echo "==> installing certbot"
  apt-get update -y >/dev/null
  apt-get install -y certbot >/dev/null
fi

# 2) Ensure webroot exists and nginx can serve /.well-known/acme-challenge/
mkdir -p "$WEBROOT/.well-known/acme-challenge"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true

# 3) Ensure the site tree exists so nginx can start after we install the vhost
mkdir -p "$SITE_ROOT/current" "$SITE_ROOT/preview"
if [[ ! -f "$SITE_ROOT/current/index.html" ]]; then
  cat > "$SITE_ROOT/current/index.html" <<HTML
<!doctype html><meta charset=utf-8><title>${SLUG}</title>
<body style="font-family:system-ui;padding:3rem;max-width:36rem;margin:auto">
<h1>Placeholder</h1><p>Slug <code>${SLUG}</code> is registered. Push a build to activate.</p>
</body>
HTML
fi

# 4) Determine this VPS's public IP (for guidance in DNS errors)
public_ip() {
  local ip=""
  for src in "https://api.ipify.org" "https://ifconfig.me" "https://icanhazip.com"; do
    ip="$(curl -fsS --max-time 3 "$src" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$ip" =~ ^[0-9.]+$ ]] && { echo "$ip"; return; }
  done
  # Fallback: primary route interface
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
}
VPS_IP="$(public_ip || true)"

# 5) DNS sanity check — fail early with a precise remediation.
echo "==> DNS check for ${FQDN}"
DIG_A="$(command -v dig >/dev/null 2>&1 && dig +short A "$FQDN" @1.1.1.1 2>/dev/null | tr '\n' ' ' || true)"
RESOLVED="$(getent hosts "$FQDN" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
if [[ -z "$DIG_A" && -z "$RESOLVED" ]]; then
  REL_SLUG_NAME="${SLUG}.${BASE%.*.*}"
  REL_WILD_NAME="*.${BASE%.*.*}"
  cat >&2 <<MSG
✗ DNS resolution failed for ${FQDN}.

  HTTP-01 challenge requires ${FQDN} to point at this VPS BEFORE certbot runs.
  Add ONE of these DNS records at your registrar (e.g. Hostinger):

    Option A — per-slug (this slug only):
      Type: A
      Name: ${REL_SLUG_NAME}          # for zone ${BASE#*.}
      Value: ${VPS_IP:-<this-VPS-IPv4>}
      TTL:  300

    Option B — wildcard (covers every future slug):
      Type: A
      Name: ${REL_WILD_NAME}          # for zone ${BASE#*.}
      Value: ${VPS_IP:-<this-VPS-IPv4>}
      TTL:  300

  After adding the record, wait 30–120s for propagation, then rerun:
      sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG} ${BASE}
MSG
  exit 10
fi
if [[ -n "$DIG_A" ]]; then echo "   dig  A: ${DIG_A}"; fi
if [[ -n "$RESOLVED" ]]; then echo "   host A: ${RESOLVED}"; fi
if [[ -n "$VPS_IP" && -n "$DIG_A$RESOLVED" ]]; then
  MATCH=0
  for ip in $DIG_A $RESOLVED; do [[ "$ip" == "$VPS_IP" ]] && MATCH=1; done
  if [[ "$MATCH" -eq 0 ]]; then
    cat >&2 <<MSG
✗ DNS mismatch: ${FQDN} resolves to '${DIG_A:-$RESOLVED}' but this VPS is ${VPS_IP}.

  Update the A record for ${FQDN} (or *.${BASE%%.*}) to point to ${VPS_IP}
  and rerun this script. HTTP-01 challenge will fail otherwise.
MSG
    exit 11
  fi
  echo "   ✓ DNS points at this VPS (${VPS_IP})"
fi

# 6) Ensure nginx serves the ACME challenge for this FQDN on :80.
if ! nginx -T 2>/dev/null | grep -qE "server_name[[:space:]]+.*\\*\\.${BASE//./\\.}"; then
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
  nginx -t
  systemctl reload nginx
fi

# 6a) Self-probe the HTTP-01 path before letting certbot hit LE's rate limits.
TOKEN="preflight-$(date +%s)-$RANDOM"
echo "$TOKEN" > "$WEBROOT/.well-known/acme-challenge/$TOKEN"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true
CHAL_URL="http://${FQDN}/.well-known/acme-challenge/${TOKEN}"
SELF="$(curl -fsS --max-time 8 "$CHAL_URL" 2>/dev/null || true)"
rm -f "$WEBROOT/.well-known/acme-challenge/$TOKEN"
if [[ "$SELF" != "$TOKEN" ]]; then
  cat >&2 <<MSG
✗ HTTP-01 preflight failed for ${CHAL_URL}
  Expected body: ${TOKEN}
  Got:           $(echo -n "${SELF:0:120}" | head -c 120)

  Likely causes:
    1. Firewall/UFW is blocking port 80. Run:  sudo ufw allow 80/tcp
    2. Another service is bound to :80 in front of nginx (Cloudflare Tunnel,
       Caddy, Apache). Check:  sudo ss -tlnp | grep ':80'
    3. Nginx isn't reloading — verify:  sudo nginx -t && sudo systemctl reload nginx
    4. DNS is pointing at a proxy (Cloudflare orange-cloud) that hides
       /.well-known/acme-challenge/. Set the record to DNS-only (grey cloud)
       or use Cloudflare DNS-01 via setup-wildcard-subdomains.sh.

  Not calling certbot to avoid burning the Let's Encrypt failure quota.
MSG
  exit 12
fi
echo "   ✓ HTTP-01 self-probe ok"

# 7) Request the certificate
if ! certbot certonly \
    --webroot -w "$WEBROOT" \
    -d "$FQDN" \
    --email "$EMAIL" \
    --agree-tos --no-eff-email \
    --non-interactive \
    --keep-until-expiring; then
  cat >&2 <<MSG
✗ certbot failed to issue a certificate for ${FQDN}.
  Inspect the last error above and /var/log/letsencrypt/letsencrypt.log
  Common causes:
    - Rate limit hit (5 failed attempts/hour or 50 certs/week per domain).
      Wait or use --staging while diagnosing.
    - CAA record on ${BASE} disallows letsencrypt.org (check DNS CAA).
    - IPv6 AAAA record present but not reachable — remove AAAA or make it work.
MSG
  exit 13
fi

# 7) Render and enable the per-slug HTTPS vhost
if [[ ! -f "$TEMPLATE" ]]; then
  echo "Template missing: $TEMPLATE" >&2
  exit 3
fi
sed -e "s/__SLUG__/${SLUG}/g" -e "s/__BASE__/${BASE}/g" "$TEMPLATE" > "$NGINX_AVAILABLE"
ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"

# Remove the temporary ACME-only stub if present — the full vhost supersedes it.
rm -f "/etc/nginx/sites-enabled/pluto-slug-${SLUG}-acme.conf"

nginx -t
systemctl reload nginx

# 8) Verify
sleep 1
CODE="$(curl -sk -o /dev/null -w '%{http_code}' "https://${FQDN}/" || true)"
echo "==> https://${FQDN}/ -> HTTP ${CODE}"

echo "OK: ${FQDN} is now served with a per-slug Let's Encrypt certificate."
echo "    Renewal: the system certbot.timer will auto-renew via webroot."
