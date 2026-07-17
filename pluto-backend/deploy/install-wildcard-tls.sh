#!/usr/bin/env bash
# Issue (or renew) a wildcard TLS cert for *.<APEX> via Let's Encrypt DNS-01.
#
# Usage:
#   sudo bash pluto-backend/deploy/install-wildcard-tls.sh app.timescard.cloud
#
# You must provide DNS-01 credentials for your provider. This script supports
# Cloudflare out of the box (most common); adapt the plugin/creds section for
# Route53, DigitalOcean, Hostinger-via-manual, etc.
#
# Cloudflare setup:
#   1. Cloudflare dashboard → My Profile → API Tokens → Create Token.
#   2. Template: "Edit zone DNS". Zone Resources → include the apex zone
#      (e.g. `timescard.cloud`). Copy the token.
#   3. echo 'dns_cloudflare_api_token = <TOKEN>' | sudo tee /etc/letsencrypt/cloudflare.ini
#      sudo chmod 600 /etc/letsencrypt/cloudflare.ini
#
# Manual DNS (any provider): re-run with FORCE_MANUAL=1 to use certbot manual.
set -euo pipefail

APEX="${1:-app.timescard.cloud}"
EMAIL="${ACME_EMAIL:-admin@$(echo "$APEX" | cut -d. -f2-)}"
CF_INI="${CF_INI:-/etc/letsencrypt/cloudflare.ini}"
SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"

echo "▶ Issuing wildcard cert for *.${APEX} (and ${APEX})"
echo "  contact email: ${EMAIL}"

# Install certbot + cloudflare plugin if missing
if ! command -v certbot >/dev/null 2>&1; then
  echo "▶ installing certbot"
  $SUDO apt-get update -y
  $SUDO apt-get install -y certbot python3-certbot-dns-cloudflare
fi

# Ensure the Cloudflare DNS plugin is actually available to THIS certbot.
# `certbot plugins` lists all registered plugins; if dns-cloudflare is missing,
# certbot rejects --dns-cloudflare-* flags with "unrecognized arguments".
ensure_cf_plugin() {
  if $SUDO certbot plugins 2>/dev/null | grep -qi 'dns-cloudflare'; then
    return 0
  fi
  echo "▶ certbot is missing the dns-cloudflare plugin — installing"
  # apt path (Debian/Ubuntu certbot from apt)
  $SUDO apt-get update -y >/dev/null 2>&1 || true
  $SUDO apt-get install -y python3-certbot-dns-cloudflare >/dev/null 2>&1 || true
  if $SUDO certbot plugins 2>/dev/null | grep -qi 'dns-cloudflare'; then
    return 0
  fi
  # snap path (certbot from snap)
  if command -v snap >/dev/null 2>&1 && snap list certbot >/dev/null 2>&1; then
    echo "▶ installing certbot-dns-cloudflare via snap"
    $SUDO snap set certbot trust-plugin-with-root=ok || true
    $SUDO snap install certbot-dns-cloudflare || true
    $SUDO snap connect certbot:plugin certbot-dns-cloudflare || true
    if $SUDO certbot plugins 2>/dev/null | grep -qi 'dns-cloudflare'; then
      return 0
    fi
  fi
  # pipx path (some distros ship certbot via pipx)
  if command -v pipx >/dev/null 2>&1; then
    $SUDO pipx inject certbot certbot-dns-cloudflare || true
    if $SUDO certbot plugins 2>/dev/null | grep -qi 'dns-cloudflare'; then
      return 0
    fi
  fi
  echo "✗ Could not install the certbot dns-cloudflare plugin automatically."
  echo "  Try one of:"
  echo "    sudo apt-get install -y python3-certbot-dns-cloudflare"
  echo "    sudo snap install certbot-dns-cloudflare \\"
  echo "      && sudo snap set certbot trust-plugin-with-root=ok \\"
  echo "      && sudo snap connect certbot:plugin certbot-dns-cloudflare"
  return 1
}

# If CF_API_TOKEN is provided in env, materialise/update the ini file automatically.
if [ -n "${CF_API_TOKEN:-}" ]; then
  echo "▶ writing Cloudflare credentials to $CF_INI"
  $SUDO mkdir -p "$(dirname "$CF_INI")"
  printf 'dns_cloudflare_api_token = %s\n' "$CF_API_TOKEN" | $SUDO tee "$CF_INI" >/dev/null
  $SUDO chmod 600 "$CF_INI"
fi

if [ "${FORCE_MANUAL:-0}" = "1" ] || [ ! -f "$CF_INI" ]; then
  echo "⚠ No Cloudflare credentials at $CF_INI (or FORCE_MANUAL=1)."
  echo "  To automate: re-run with CF_API_TOKEN='<cloudflare-token-with-Zone:DNS:Edit>'"
  echo "  Falling back to interactive DNS-01 — you'll paste TXT records manually."
  $SUDO certbot certonly \
    --manual \
    --preferred-challenges dns \
    --agree-tos --no-eff-email \
    --email "$EMAIL" \
    --cert-name "$APEX" \
    -d "*.${APEX}" -d "${APEX}"
else
  ensure_cf_plugin
  $SUDO certbot certonly \
    --dns-cloudflare \
    --dns-cloudflare-credentials "$CF_INI" \
    --dns-cloudflare-propagation-seconds 30 \
    --agree-tos --no-eff-email \
    --email "$EMAIL" \
    --cert-name "$APEX" \
    -d "*.${APEX}" -d "${APEX}"
fi

echo "✓ Cert issued at /etc/letsencrypt/live/${APEX}/"
echo
echo "Next:"
echo "  sudo cp pluto-backend/deploy/nginx/wildcard-app.conf \\"
echo "          /etc/nginx/sites-available/wildcard-${APEX}.conf"
echo "  sudo ln -sf /etc/nginx/sites-available/wildcard-${APEX}.conf \\"
echo "              /etc/nginx/sites-enabled/"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo
echo "Renewal is automatic via certbot.timer. Verify with: sudo certbot renew --dry-run"
