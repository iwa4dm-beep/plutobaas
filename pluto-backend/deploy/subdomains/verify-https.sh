#!/usr/bin/env bash
# Verify HTTPS on each subdomain and that the served certificate matches the
# expected hostname (CN or SAN). Exits 0 only when every host passes; use as
# the last step of a deploy pipeline.
#
# Env:
#   BASE_DOMAIN   required, e.g. timescard.cloud
#   HOSTS         optional space-separated list (default: app.<BASE> api.<BASE> dashboard.<BASE>)
#   EXPECT_HTTP   optional acceptable statuses regex (default: ^(200|301|302|401|403)$)
set -euo pipefail

BASE_DOMAIN="${BASE_DOMAIN:?set BASE_DOMAIN}"
HOSTS_STR="${HOSTS:-app.$BASE_DOMAIN api.$BASE_DOMAIN dashboard.$BASE_DOMAIN}"
EXPECT_HTTP="${EXPECT_HTTP:-^(200|301|302|401|403)$}"
read -ra HOSTS <<<"$HOSTS_STR"

fail=0
printf '%-40s %-6s %s\n' "HOST" "HTTP" "CERT"
printf '%-40s %-6s %s\n' "----" "----" "----"

for host in "${HOSTS[@]}"; do
  # 1) HTTP status over HTTPS
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/" || echo "000")

  # 2) Read the served certificate and extract CN + SANs
  cert_info=$(echo | timeout 10 openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
              | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null || true)
  cn=$(echo "$cert_info" | sed -n 's/.*CN *= *\([^,]*\).*/\1/p' | head -n1 | tr -d ' ')
  sans=$(echo "$cert_info" | grep -oE 'DNS:[^, ]+' | sed 's/DNS://g' | tr '\n' ',' | sed 's/,$//')

  http_ok=0; cert_ok=0
  [[ "$code" =~ $EXPECT_HTTP ]] && http_ok=1
  if [ "$cn" = "$host" ] || [[ ",$sans," == *",$host,"* ]]; then cert_ok=1; fi

  mark="✓"; [ "$http_ok" = 1 ] && [ "$cert_ok" = 1 ] || { mark="✘"; fail=1; }
  printf '%s %-38s %-6s CN=%s%s\n' "$mark" "$host" "$code" "${cn:-?}" \
         "$([ "$cert_ok" = 1 ] || echo "  (expected $host; SANs=[$sans])")"
done

echo
if [ "$fail" = 0 ]; then
  echo "✅ all subdomains verified"
  exit 0
else
  echo "✘ one or more subdomains failed HTTPS / certificate verification"
  exit 1
fi
