#!/usr/bin/env bash
# deploy-site-from-github.sh — one command to put ANY GitHub repo live on a
# dedicated subdomain (DNS check → clone/build → nginx vhost → Let's Encrypt
# TLS → verify). Re-running pulls the latest commit and redeploys.
#
# It reuses install-dashboard-from-github.sh for the clone/build/vhost work
# (that script is fully env-driven and handles both TanStack SSR and SPA
# builds), and adds:
#   * DNS A/AAAA preflight against this VPS's public IP
#   * HTTP-01 certificate issuance for the subdomain (webroot)
#   * a second vhost render so the final config is HTTPS
#
# Usage (on the VPS, as root):
#   sudo bash pluto-backend/deploy/deploy-site-from-github.sh \
#     https://github.com/MansurAzad/edbh dhb.timescard.cloud
#
# Optional env:
#   BRANCH      git branch (default: main)
#   APP_DIR     checkout dir (default: /root/sites/<repo-name>)
#   PORT        local port for SSR mode (default: derived from the domain)
#   SERVICE     systemd unit name for SSR mode (default: pluto-site-<slug>)
#   CERT_EMAIL  Let's Encrypt contact (default: admin@<base domain>)
#   SKIP_TLS=1  stop after the HTTP vhost (useful when DNS is still pending)
set -uo pipefail

REPO_URL="${1:-${REPO_URL:-}}"
DOMAIN="${2:-${DOMAIN:-}}"
BRANCH="${BRANCH:-main}"

log()  { printf '\033[1;36m[%s]\033[0m %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo)"
[[ -n "$REPO_URL" ]] || die "usage: deploy-site-from-github.sh <repo-url> <domain>" 2
[[ -n "$DOMAIN" ]]   || die "usage: deploy-site-from-github.sh <repo-url> <domain>" 2
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || die "invalid domain: $DOMAIN" 2

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
INSTALLER="$HERE/install-dashboard-from-github.sh"
[[ -f "$INSTALLER" ]] || die "missing $INSTALLER (run install-deploy-scripts.sh first)" 31

REPO_NAME="$(basename "${REPO_URL%.git}")"
SLUG="${DOMAIN%%.*}"
BASE="${DOMAIN#*.}"
APP_DIR="${APP_DIR:-/root/sites/$REPO_NAME}"
SERVICE="${SERVICE:-pluto-site-$SLUG}"
CERT_EMAIL="${CERT_EMAIL:-admin@${BASE}}"

# Deterministic per-domain port in 8800-8899 so multiple sites coexist.
if [[ -z "${PORT:-}" ]]; then
  h=0; for ((i = 0; i < ${#DOMAIN}; i++)); do h=$(( (h * 31 + $(printf '%d' "'${DOMAIN:i:1}")) % 100 )); done
  PORT=$(( 8800 + h ))
fi

bold_hdr() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

bold_hdr "1/5 DNS preflight — $DOMAIN"
MYIP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')"
if [[ -z "$RESOLVED" ]]; then
  warn "$DOMAIN does not resolve yet. Add an A record → ${MYIP:-<this VPS IP>} at your DNS provider."
  warn "Continuing with the HTTP vhost; TLS will be skipped until DNS resolves."
  SKIP_TLS=1
elif [[ -n "$MYIP" && "$RESOLVED" != "$MYIP" ]]; then
  warn "$DOMAIN resolves to $RESOLVED but this VPS is $MYIP — TLS (HTTP-01) will fail."
  warn "Fix the A record, then re-run this same command."
  SKIP_TLS=1
else
  ok "$DOMAIN → $RESOLVED (this VPS)"
fi

bold_hdr "2/5 Clone + build + nginx (HTTP) — $REPO_NAME@$BRANCH"
log "APP_DIR=$APP_DIR SERVICE=$SERVICE PORT=$PORT"
REPO_URL="$REPO_URL" BRANCH="$BRANCH" APP_DIR="$APP_DIR" DOMAIN="$DOMAIN" \
  PORT="$PORT" SERVICE="$SERVICE" bash "$INSTALLER" || die "build/deploy failed" 34
ok "site built and served over HTTP"

if [[ "${SKIP_TLS:-0}" == "1" ]]; then
  bold_hdr "3/5 TLS — skipped"
  warn "Skipped certificate issuance (SKIP_TLS=1 or DNS not pointing here)."
  echo
  echo "Live (HTTP): http://${DOMAIN}/"
  echo "Re-run after DNS is correct to get HTTPS:"
  echo "  sudo bash $HERE/deploy-site-from-github.sh $REPO_URL $DOMAIN"
  exit 0
fi

bold_hdr "3/5 TLS certificate — $DOMAIN"
if [[ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  ok "certificate already present"
else
  command -v certbot >/dev/null 2>&1 || {
    log "installing certbot"
    apt-get update -qq && apt-get install -y -qq certbot >/dev/null
  }
  mkdir -p /var/www/html/.well-known/acme-challenge
  chown -R root:www-data /var/www/html 2>/dev/null || true
  chmod -R 755 /var/www/html/.well-known

  # Self-test: make sure the vhost serves the ACME webroot instead of the SPA
  # fallback (index.html), which is what makes certbot report "unauthorized".
  PROBE="pluto-selftest-$(date -u +%s)"
  echo "$PROBE" > "/var/www/html/.well-known/acme-challenge/$PROBE"
  body="$(curl -s --max-time 8 --resolve "${DOMAIN}:80:127.0.0.1" \
            "http://${DOMAIN}/.well-known/acme-challenge/${PROBE}" || true)"
  rm -f "/var/www/html/.well-known/acme-challenge/$PROBE"
  if [[ "$body" != "$PROBE" ]]; then
    warn "ACME webroot not served correctly for ${DOMAIN} (got: ${body:0:60})"
    warn "Re-rendering vhost with the acme-challenge location, then retrying."
    REPO_URL="$REPO_URL" BRANCH="$BRANCH" APP_DIR="$APP_DIR" DOMAIN="$DOMAIN" \
      PORT="$PORT" SERVICE="$SERVICE" bash "$INSTALLER" >/dev/null 2>&1 || true
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi


  if certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
       --non-interactive --agree-tos -m "$CERT_EMAIL" --keep-until-expiring; then
    ok "certificate issued for $DOMAIN"
  else
    warn "certbot failed — the site stays on HTTP. Check DNS/port 80 and re-run."
    warn "Diagnostics: bash $HERE/diagnose-cert-failure.sh $SLUG $BASE"
    exit 35
  fi
fi

bold_hdr "4/5 Re-render vhost with HTTPS"
REPO_URL="$REPO_URL" BRANCH="$BRANCH" APP_DIR="$APP_DIR" DOMAIN="$DOMAIN" \
  PORT="$PORT" SERVICE="$SERVICE" bash "$INSTALLER" || die "HTTPS vhost render failed" 34

bold_hdr "5/5 Verify"
code="$(curl -sk --max-time 15 --resolve "${DOMAIN}:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://${DOMAIN}/")"
[[ "$code" == "200" ]] || die "https://${DOMAIN}/ → HTTP $code" 36
hdr="$(curl -skI --max-time 15 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/" | tr -d '\r' | awk 'tolower($1)=="x-pluto-primary:"{print $2; exit}')"
ok "https://${DOMAIN}/ → 200 (X-Pluto-Primary: ${hdr:-<missing>})"


cat <<EOF

✅ ${DOMAIN} is live.

   Repo    : ${REPO_URL} (${BRANCH} @ $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?'))
   Checkout: ${APP_DIR}
   Service : ${SERVICE} (if SSR mode) on 127.0.0.1:${PORT}
   URL     : https://${DOMAIN}/

Redeploy latest code anytime with the exact same command.
Next (optional) — connect this site to Pluto BaaS:
   sudo bash ${HERE}/connect-app-to-pluto.sh ${APP_DIR} ${DOMAIN}
EOF
