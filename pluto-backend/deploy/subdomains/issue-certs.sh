#!/usr/bin/env bash
# Issue / renew Let's Encrypt certs for app.<BASE>, api.<BASE>, dashboard.<BASE>
# using certbot's nginx plugin, then reload nginx safely.
#
# Env:
#   BASE_DOMAIN         required, e.g. timescard.cloud
#   LETSENCRYPT_EMAIL   required for first-time issuance
#   STAGING             optional; set to "1" to use LE staging (avoids rate limits)
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi

BASE_DOMAIN="${BASE_DOMAIN:?set BASE_DOMAIN}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL}"
HOSTS=("app.$BASE_DOMAIN" "api.$BASE_DOMAIN" "dashboard.$BASE_DOMAIN")

if ! command -v certbot >/dev/null 2>&1; then
  echo "▶ installing certbot + nginx plugin"
  apt-get update -y
  apt-get install -y certbot python3-certbot-nginx
fi

STAGING_FLAG=""
[ "${STAGING:-0}" = "1" ] && STAGING_FLAG="--staging"

# Certbot's nginx installer needs each :443 server block to already exist and
# reference the cert paths. render-nginx.sh writes those blocks — but the cert
# files don't exist yet, so `nginx -t` fails. Work around by temporarily
# disabling the :443 blocks, letting certbot issue over :80, then re-enable.
disable_https_blocks() {
  for h in "${HOSTS[@]}"; do
    local f=/etc/nginx/sites-available/$h.conf
    [ -f "$f" ] || continue
    if grep -q "listen 443" "$f" && [ ! -f "/etc/letsencrypt/live/$h/fullchain.pem" ]; then
      cp "$f" "$f.bak"
      # Comment the whole :443 server{} block.
      awk '
        /^server \{/ { buf=$0"\n"; in_block=1; brace=1; is_https=0; next }
        in_block {
          buf=buf $0 "\n"
          if ($0 ~ /listen 443/) is_https=1
          for (i=1;i<=length($0);i++){c=substr($0,i,1); if(c=="{")brace++; else if(c=="}")brace--}
          if (brace==0) {
            if (is_https) { gsub(/\n/, "\n# ", buf); print "# " buf } else { print buf }
            in_block=0; buf=""
          }
          next
        }
        { print }
      ' "$f.bak" > "$f"
    fi
  done
}

restore_https_blocks() {
  for h in "${HOSTS[@]}"; do
    [ -f "/etc/nginx/sites-available/$h.conf.bak" ] && \
      mv "/etc/nginx/sites-available/$h.conf.bak" "/etc/nginx/sites-available/$h.conf"
  done
}

echo "▶ preparing nginx for ACME (temporarily disabling :443 blocks with no cert yet)"
disable_https_blocks
nginx -t && systemctl reload nginx

echo "▶ issuing certificates (per-host, isolated)"
for h in "${HOSTS[@]}"; do
  if [ -f "/etc/letsencrypt/live/$h/fullchain.pem" ]; then
    echo "  ✓ $h already has a cert — skipping issuance"
    continue
  fi
  certbot certonly --nginx $STAGING_FLAG \
    --non-interactive --agree-tos \
    -m "$LETSENCRYPT_EMAIL" \
    -d "$h"
done

echo "▶ restoring :443 server blocks"
restore_https_blocks

echo "▶ testing final nginx config"
nginx -t

echo "▶ reloading nginx"
systemctl reload nginx

echo "✅ certificates issued + nginx reloaded"
