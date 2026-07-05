#!/usr/bin/env bash
# Toggle HTTP/3 (QUIC) on/off in the api.timescard.cloud nginx site,
# run `nginx -t`, reload nginx, and verify Alt-Svc is being advertised.
#
# Usage:
#   bash deploy/toggle-http3.sh on  [domain]
#   bash deploy/toggle-http3.sh off [domain]
#   bash deploy/toggle-http3.sh verify [domain]
set -euo pipefail

ACTION="${1:-verify}"
DOMAIN="${2:-api.timescard.cloud}"
CONF="/etc/nginx/sites-available/${DOMAIN}.conf"
SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"

verify() {
  echo "▶ verifying HTTP/3 on https://$DOMAIN"
  local alt
  alt=$(curl -sSI "https://$DOMAIN/livez" | grep -i '^alt-svc:' || true)
  if [ -n "$alt" ]; then
    echo "  ✔ Alt-Svc advertised: $alt"
  else
    echo "  ✘ no Alt-Svc header — HTTP/3 not advertised"
  fi
  if command -v curl >/dev/null && curl --help all 2>/dev/null | grep -q -- '--http3'; then
    echo "▶ curl --http3 handshake test"
    if curl -sS --http3 -o /dev/null -w "  http_version=%{http_version}\n" "https://$DOMAIN/livez"; then
      :
    else
      echo "  ✘ curl --http3 failed (server may not have QUIC bound on :443/udp)"
    fi
  else
    echo "  ℹ curl has no --http3 support; skipping direct h3 handshake"
  fi
}

apply() {
  local mode="$1"
  [ -f "$CONF" ] || { echo "❌ $CONF not found — run install-nginx-site.sh first" >&2; exit 1; }
  $SUDO cp "$CONF" "$CONF.bak.$(date +%s)"
  case "$mode" in
    on)
      # Uncomment the three quic/Alt-Svc lines
      $SUDO sed -i -E \
        -e 's|^([[:space:]]*)#[[:space:]]*(listen 443 quic reuseport;)|\1\2|' \
        -e 's|^([[:space:]]*)#[[:space:]]*(listen \[::\]:443 quic reuseport;)|\1\2|' \
        -e "s|^([[:space:]]*)#[[:space:]]*(add_header Alt-Svc 'h3=\":443\"; ma=86400' always;)|\1\2|" \
        "$CONF"
      echo "▶ HTTP/3 lines enabled in $CONF"
      ;;
    off)
      $SUDO sed -i -E \
        -e 's|^([[:space:]]*)(listen 443 quic reuseport;)|\1# \2|' \
        -e 's|^([[:space:]]*)(listen \[::\]:443 quic reuseport;)|\1# \2|' \
        -e "s|^([[:space:]]*)(add_header Alt-Svc 'h3=\":443\"; ma=86400' always;)|\1# \2|" \
        "$CONF"
      echo "▶ HTTP/3 lines commented out in $CONF"
      ;;
    *) echo "usage: $0 on|off|verify [domain]" >&2; exit 1;;
  esac

  echo "▶ nginx -t"
  $SUDO nginx -t
  echo "▶ reload nginx"
  $SUDO systemctl reload nginx
  echo "✅ nginx reloaded"
  sleep 1
  verify
}

case "$ACTION" in
  on|off) apply "$ACTION" ;;
  verify) verify ;;
  *) echo "usage: $0 on|off|verify [domain]" >&2; exit 1 ;;
esac
