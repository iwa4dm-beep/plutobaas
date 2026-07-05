#!/usr/bin/env bash
# Test OCSP stapling for a domain using `openssl s_client -status`.
#
# Note: Let's Encrypt (ISRG) has stopped issuing OCSP responder URLs in new
# certificates (2025+). If your cert has no OCSP URI, stapling is silently
# ignored by nginx — the correct fix is `ssl_stapling off;` which is what
# api.timescard.cloud.conf already sets to suppress warnings.
#
# Usage:
#   bash deploy/test-ocsp.sh                        # api.timescard.cloud
#   bash deploy/test-ocsp.sh api.example.com
set -euo pipefail

DOMAIN="${1:-api.timescard.cloud}"
PORT="${2:-443}"

echo "▶ Fetching certificate for $DOMAIN:$PORT"
CERT=$(mktemp)
echo | openssl s_client -connect "$DOMAIN:$PORT" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout > /dev/null 2>&1 || true

echo "▶ Checking OCSP responder URI in cert extension"
OCSP_URI=$(echo | openssl s_client -connect "$DOMAIN:$PORT" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -ocsp_uri || true)

if [ -z "$OCSP_URI" ]; then
  echo "  ℹ no OCSP URI in certificate (common for Let's Encrypt 2025+)"
  echo "  → nginx correctly ignores ssl_stapling; keep 'ssl_stapling off;'"
  rm -f "$CERT"
  exit 0
fi
echo "  ✔ OCSP URI: $OCSP_URI"

echo "▶ Requesting stapled OCSP response via TLS handshake"
OUT=$(echo QUIT | openssl s_client -connect "$DOMAIN:$PORT" -servername "$DOMAIN" -status 2>/dev/null || true)

if echo "$OUT" | grep -q "OCSP Response Status: successful"; then
  echo "  ✔ OCSP stapling is WORKING"
  echo "$OUT" | sed -n '/OCSP response:/,/Cert Status:/p' | head -20
  rm -f "$CERT"
  exit 0
fi

if echo "$OUT" | grep -q "OCSP response: no response sent"; then
  echo "  ✘ stapling is NOT active — no OCSP response returned"
  echo "  Fix options:"
  echo "   1. Enable in nginx:  ssl_stapling on; ssl_stapling_verify on;"
  echo "      resolver 1.1.1.1 8.8.8.8 valid=300s;"
  echo "   2. Or disable cleanly (recommended for LE 2025+):"
  echo "      ssl_stapling off; ssl_stapling_verify off;"
  rm -f "$CERT"
  exit 1
fi

echo "  ⚠ unexpected output — inspect manually:"
echo "$OUT" | grep -iE "ocsp|stapl" || true
rm -f "$CERT"
exit 1
