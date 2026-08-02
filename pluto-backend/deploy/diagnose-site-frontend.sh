#!/usr/bin/env bash
# Explain WHICH frontend a hostname is actually serving, over HTTP and HTTPS.
#
# Typical symptom this diagnoses:
#   You deployed your own project to  https://<sub>.timescard.cloud/
#   but the Pluto BaaS dashboard/marketing app shows up instead.
#
# Root cause (99% of the time): the sub-domain has no TLS certificate yet, so
# the HTTPS request has no matching `server` block and nginx answers it with the
# `default_server` vhost — which is the Pluto primary frontend. HTTP (port 80)
# serves the correct site; HTTPS silently falls back.
#
# Usage:
#   sudo bash diagnose-site-frontend.sh dbh.timescard.cloud
set -uo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "usage: $0 <fqdn>"; exit 2; }

c_r() { printf '\033[31m%s\033[0m\n' "$*"; }
c_g() { printf '\033[32m%s\033[0m\n' "$*"; }
c_y() { printf '\033[33m%s\033[0m\n' "$*"; }
hdr() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

hdr "1. Nginx vhosts that claim ${DOMAIN}"
grep -RlE "server_name[[:space:]]+[^;]*\b${DOMAIN}\b" /etc/nginx 2>/dev/null \
  | grep -v '\.bak\.' | sed 's/^/   /' || echo "   (none!)"

hdr "2. default_server blocks (these answer unmatched requests)"
grep -RnE "listen[[:space:]][^;]*default_server" /etc/nginx 2>/dev/null \
  | grep -v '\.bak\.' | sed 's/^/   /' || echo "   (none)"

hdr "3. TLS certificate"
if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  c_g "   ✓ certificate present for ${DOMAIN}"
  HAS_CERT=1
else
  c_r "   ✗ NO certificate for ${DOMAIN}"
  HAS_CERT=0
fi

probe() { # port -> prints marker + title
  local port="$1" scheme="$2"
  local body
  body="$(curl -sk --max-time 10 --resolve "${DOMAIN}:${port}:127.0.0.1" \
            "${scheme}://${DOMAIN}/" || true)"
  local title
  title="$(printf '%s' "$body" | tr -d '\n' | sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p' | cut -c1-80)"
  local primary
  primary="$(curl -skI --max-time 10 --resolve "${DOMAIN}:${port}:127.0.0.1" \
              "${scheme}://${DOMAIN}/" | tr -d '\r' \
              | awk 'tolower($1)=="x-pluto-primary:"{print $2; exit}')"
  echo "   title           : ${title:-<none>}"
  echo "   X-Pluto-Primary : ${primary:-<absent>}"
  if [ -n "$primary" ] && [ "$primary" != "$DOMAIN" ]; then
    c_r "   ✗ served by the Pluto primary frontend (${primary}), NOT your project"
    return 1
  fi
  c_g "   ✓ served by the ${DOMAIN} vhost"
  return 0
}

hdr "4. What port 80 (HTTP) serves"
probe 80 http; HTTP_OK=$?

hdr "5. What port 443 (HTTPS) serves"
probe 443 https; HTTPS_OK=$?

hdr "Verdict"
if [ "$HTTP_OK" -eq 0 ] && [ "$HTTPS_OK" -ne 0 ]; then
  c_y "HTTP serves your project, HTTPS falls back to the Pluto default_server."
  if [ "$HAS_CERT" -eq 0 ]; then
    echo "Cause : no TLS cert for ${DOMAIN}, so nginx has no HTTPS server block"
    echo "        for this hostname and uses \`default_server\` instead."
    echo "Fix   : issue the certificate, which also re-renders the HTTPS vhost:"
    echo "        sudo bash /opt/pluto/deploy/deploy-site-from-github.sh <repo-url> ${DOMAIN}"
  else
    echo "Cause : the cert exists but the vhost was not re-rendered for HTTPS."
    echo "Fix   : sudo bash /opt/pluto/deploy/deploy-site-from-github.sh <repo-url> ${DOMAIN}"
  fi
  exit 1
fi
if [ "$HTTP_OK" -ne 0 ] && [ "$HTTPS_OK" -ne 0 ]; then
  c_r "Both HTTP and HTTPS serve the Pluto frontend — the ${DOMAIN} vhost is"
  echo "missing or disabled. Re-run the deploy script for this domain."
  exit 1
fi
c_g "✓ ${DOMAIN} serves your own project on both HTTP and HTTPS."
