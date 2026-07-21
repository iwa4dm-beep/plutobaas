#!/usr/bin/env bash
# list-active-subdomains.sh
# --------------------------------------------------------------
# BPS/Pluto VPS-এ বর্তমানে চালু থাকা subdomain-গুলোর তালিকা দেখায়।
# প্রতিটি subdomain এর জন্য দেখায়:
#   - nginx config আছে কি না, enabled কি না
#   - HTTP (80) reachable কি না
#   - HTTPS (443) reachable + SSL valid কি না
#   - SSL certificate কোন CN এর জন্য এবং কবে expire হবে
#   - worker slug directory আছে কি না
#
# Usage (VPS-এ SSH করে):
#   sudo bash /opt/pluto-backend/deploy/list-active-subdomains.sh
#   sudo bash list-active-subdomains.sh --domain app.timescard.cloud
#   sudo bash list-active-subdomains.sh --json
# --------------------------------------------------------------
set -euo pipefail

BASE_DOMAIN="${BASE_DOMAIN:-app.timescard.cloud}"
NGINX_SITES_ENABLED="${NGINX_SITES_ENABLED:-/etc/nginx/sites-enabled}"
NGINX_SITES_AVAILABLE="${NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}"
WORKER_SITES_ROOT="${WORKER_SITES_ROOT:-/var/lib/pluto/sites}"
OUTPUT_JSON=0
SSL_WARN_DAYS="${SSL_WARN_DAYS:-30}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) BASE_DOMAIN="$2"; shift 2 ;;
    --json)   OUTPUT_JSON=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

C_R=$'\e[31m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_B=$'\e[36m'; C_0=$'\e[0m'
[[ -t 1 ]] || { C_R=""; C_G=""; C_Y=""; C_B=""; C_0=""; }

have() { command -v "$1" >/dev/null 2>&1; }

TOTAL=0
READY=0
NGINX_OK=0
SSL_OK=0
SSL_EXPIRING=0
SSL_BAD=0
BROKEN=0

# ---------- subdomain হোস্টগুলো সংগ্রহ ---------------
declare -A HOSTS=()

# 1) nginx sites-enabled থেকে server_name বের করা
if [[ -d "$NGINX_SITES_ENABLED" ]]; then
  while IFS= read -r file; do
    # multi-line server_name সাপোর্ট
    awk '
      /server_name/ {
        sub(/.*server_name/, "");
        gsub(";", "");
        print;
      }' "$file" | tr ' ' '\n' | while read -r n; do
        [[ -z "$n" || "$n" == "_" ]] && continue
        # শুধু আমাদের base domain এর subdomain-গুলো
        if [[ "$n" == *".$BASE_DOMAIN" || "$n" == "$BASE_DOMAIN" ]]; then
          echo "$n"
        fi
      done
  done < <(find "$NGINX_SITES_ENABLED" -type f -o -type l 2>/dev/null) | sort -u >/tmp/.pluto_hosts.$$
  while IFS= read -r h; do HOSTS["$h"]=1; done </tmp/.pluto_hosts.$$
  rm -f /tmp/.pluto_hosts.$$
fi

# 2) worker slug directories থেকে
if [[ -d "$WORKER_SITES_ROOT" ]]; then
  for d in "$WORKER_SITES_ROOT"/*/; do
    [[ -d "$d" ]] || continue
    slug="$(basename "$d")"
    HOSTS["${slug}.${BASE_DOMAIN}"]=1
  done
fi

if [[ ${#HOSTS[@]} -eq 0 ]]; then
  echo "${C_Y}কোনো subdomain পাওয়া যায়নি ($BASE_DOMAIN এর অধীনে)।${C_0}"
  exit 0
fi

# ---------- প্রতিটি host চেক ------------------------
check_host() {
  local host="$1"
  local ng_avail="no" ng_enabled="no" ng_test="?"
  local http_code="000" https_code="000"
  local ssl_valid="no" ssl_cn="-" ssl_expiry="-" ssl_days="-"
  local ssl_expiring_soon="no" ready="no"
  local slug_dir="no"

  # nginx presence
  if compgen -G "$NGINX_SITES_AVAILABLE/*" >/dev/null 2>&1; then
    if grep -rlE "server_name[^;]*\b${host//./\\.}\b" "$NGINX_SITES_AVAILABLE" >/dev/null 2>&1; then
      ng_avail="yes"
    fi
  fi
  if compgen -G "$NGINX_SITES_ENABLED/*" >/dev/null 2>&1; then
    if grep -rlE "server_name[^;]*\b${host//./\\.}\b" "$NGINX_SITES_ENABLED" >/dev/null 2>&1; then
      ng_enabled="yes"
    fi
  fi

  # worker slug dir
  local slug="${host%%.$BASE_DOMAIN}"
  [[ -d "$WORKER_SITES_ROOT/$slug" ]] && slug_dir="yes"

  # HTTP probe
  if have curl; then
    http_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 6 --resolve "${host}:80:127.0.0.1" "http://${host}/" || echo "000")
    https_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 8 --resolve "${host}:443:127.0.0.1" -k "https://${host}/" || echo "000")
  fi

  # SSL cert inspect (local nginx)
  if have openssl; then
    local cert
    cert=$(echo | timeout 6 openssl s_client -servername "$host" -connect 127.0.0.1:443 2>/dev/null </dev/null | openssl x509 -noout -subject -enddate 2>/dev/null || true)
    if [[ -n "$cert" ]]; then
      ssl_cn=$(echo "$cert" | awk -F'CN *= *' '/subject/{print $2}' | awk -F',' '{print $1}' | tr -d ' ')
      ssl_expiry=$(echo "$cert" | awk -F'=' '/notAfter/{print $2}')
      if [[ -n "$ssl_expiry" ]]; then
        local end_ts now_ts
        end_ts=$(date -d "$ssl_expiry" +%s 2>/dev/null || echo 0)
        now_ts=$(date +%s)
        if [[ "$end_ts" -gt "$now_ts" ]]; then
          ssl_valid="yes"
          ssl_days=$(( (end_ts - now_ts) / 86400 ))
          if [[ "$ssl_days" =~ ^[0-9]+$ && "$ssl_days" -le "$SSL_WARN_DAYS" ]]; then
            ssl_expiring_soon="yes"
          fi
        fi
      fi
    fi
  fi

  if [[ "$ng_enabled" == "yes" && "$ssl_valid" == "yes" && "$ssl_expiring_soon" == "no" && "$https_code" =~ ^[23] && "$slug_dir" == "yes" ]]; then
    ready="yes"
  fi

  if [[ "$OUTPUT_JSON" != "1" ]]; then
    TOTAL=$((TOTAL + 1))
    [[ "$ready" == "yes" ]] && READY=$((READY + 1)) || BROKEN=$((BROKEN + 1))
    [[ "$ng_enabled" == "yes" ]] && NGINX_OK=$((NGINX_OK + 1))
    [[ "$ssl_valid" == "yes" ]] && SSL_OK=$((SSL_OK + 1)) || SSL_BAD=$((SSL_BAD + 1))
    [[ "$ssl_expiring_soon" == "yes" ]] && SSL_EXPIRING=$((SSL_EXPIRING + 1))
  fi

  if [[ "$OUTPUT_JSON" == "1" ]]; then
    printf '{"host":"%s","nginx_enabled":"%s","nginx_available":"%s","slug_dir":"%s","http":"%s","https":"%s","ssl_valid":"%s","ssl_expiring_soon":"%s","ssl_cn":"%s","ssl_expiry":"%s","ssl_days_left":"%s","ready":"%s"}\n' \
      "$host" "$ng_enabled" "$ng_avail" "$slug_dir" "$http_code" "$https_code" "$ssl_valid" "$ssl_expiring_soon" "$ssl_cn" "$ssl_expiry" "$ssl_days" "$ready"
    return
  fi

  local ssl_color="$C_R"; [[ "$ssl_valid" == "yes" ]] && ssl_color="$C_G"
  local https_color="$C_R"; [[ "$https_code" =~ ^2|^3 ]] && https_color="$C_G"
  local ng_color="$C_R"; [[ "$ng_enabled" == "yes" ]] && ng_color="$C_G"
  local exp_note=""; [[ "$ssl_expiring_soon" == "yes" ]] && exp_note=" ${C_Y}EXPIRING≤${SSL_WARN_DAYS}d${C_0}"

  printf "%b%-45s%b  nginx=%b%-3s%b  http=%-3s  https=%b%-3s%b  ssl=%b%-3s%b (%s, %s days)%b  slug=%s  ready=%s\n" \
    "$C_B" "$host" "$C_0" \
    "$ng_color" "$ng_enabled" "$C_0" \
    "$http_code" \
    "$https_color" "$https_code" "$C_0" \
    "$ssl_color" "$ssl_valid" "$C_0" \
    "$ssl_cn" "$ssl_days" "$exp_note" \
    "$slug_dir" "$ready"
}

if [[ "$OUTPUT_JSON" == "1" ]]; then
  echo "["
  first=1
  for h in $(printf '%s\n' "${!HOSTS[@]}" | sort); do
    [[ $first -eq 0 ]] && echo ","
    first=0
    check_host "$h"
  done
  echo "]"
else
  echo "${C_B}== Active subdomains under *.${BASE_DOMAIN} ==${C_0}"
  echo "nginx test: $(nginx -t 2>&1 | tail -n1)"
  echo
  for h in $(printf '%s\n' "${!HOSTS[@]}" | sort); do
    check_host "$h"
  done
  echo
  echo "${C_B}== SSL pre-check summary (warning threshold: ${SSL_WARN_DAYS} days) ==${C_0}"
  printf "%-18s %6s\n" "Total" "$TOTAL"
  printf "%-18s %6s\n" "Ready" "$READY"
  printf "%-18s %6s\n" "Nginx enabled" "$NGINX_OK"
  printf "%-18s %6s\n" "SSL valid" "$SSL_OK"
  printf "%-18s %6s\n" "SSL expiring soon" "$SSL_EXPIRING"
  printf "%-18s %6s\n" "SSL invalid" "$SSL_BAD"
  printf "%-18s %6s\n" "Needs attention" "$BROKEN"
  echo
  echo "Legend: nginx=sites-enabled আছে কি না · http/https=লোকাল probe status · ssl=লোকাল cert valid + বাকি দিন · EXPIRING≤${SSL_WARN_DAYS}d=৩০ দিনের মধ্যে expire · slug=/var/lib/pluto/sites/<slug> আছে কি না"
fi
