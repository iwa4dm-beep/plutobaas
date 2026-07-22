#!/usr/bin/env bash
# repair-realtime-ws.sh
# -----------------------------------------------------------------------------
# One-shot VPS repair for browser errors like:
#   WebSocket connection to wss://api.timescard.cloud/realtime/v1?... failed: 404
#
# It fixes the two common causes:
#   1) stale Pluto API code only registered /realtime/v1/websocket
#   2) nginx lacks an explicit WebSocket upgrade location for /realtime/v1
#
# Usage on VPS from repo root:
#   sudo bash pluto-backend/deploy/repair-realtime-ws.sh
#
# Optional env:
#   DOMAIN=api.timescard.cloud API_PORT=3000 PLUTO_ANON_KEY=pk_anon_...
set -euo pipefail

DOMAIN="${DOMAIN:-api.timescard.cloud}"
API_PORT="${API_PORT:-3000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROUTE="$ROOT/packages/api/src/routes/realtime.ts"
NGINX_CONF="${NGINX_CONF:-}"
SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"

green() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
blue()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
red()   { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
die()   { red "$*"; exit 1; }

find_nginx_conf() {
  if [ -n "$NGINX_CONF" ] && [ -f "$NGINX_CONF" ]; then printf '%s' "$NGINX_CONF"; return; fi
  for c in \
    "/etc/nginx/sites-enabled/${DOMAIN}.conf" \
    "/etc/nginx/sites-available/${DOMAIN}.conf" \
    "/etc/nginx/conf.d/${DOMAIN}.conf"; do
    [ -f "$c" ] && { printf '%s' "$c"; return; }
  done
}

patch_realtime_route() {
  [ -f "$ROUTE" ] || die "realtime route not found: $ROUTE"
  blue "patch API realtime route"
  cp -a "$ROUTE" "${ROUTE}.bak.$(date +%s)"
  python3 - "$ROUTE" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, 'r', encoding='utf-8').read()

changed = False

# Old deployments often had only /realtime/v1/websocket. Register both the
# Supabase-style base path and explicit websocket path.
if "app.get('/realtime/v1', { websocket: true }, websocketHandler);" not in text:
    text = text.replace(
        "app.get('/realtime/v1/websocket', { websocket: true }, websocketHandler);",
        "// Support both Supabase-style /realtime/v1 and explicit /realtime/v1/websocket.\n"
        "  app.get('/realtime/v1', { websocket: true }, websocketHandler);\n"
        "  app.get('/realtime/v1/websocket', { websocket: true }, websocketHandler);",
    )
    changed = True

# Ensure clients that pass ?channel=<topic> are attached immediately after the
# handshake, matching the currently deployed frontend SDK behavior.
if "url.searchParams.get('channel')" not in text:
    text = text.replace(
        "send({ type: 'connected', connId, role, userId });",
        "send({ type: 'connected', connId, role, userId });\n"
        "    const initialChannel = url.searchParams.get('channel');\n"
        "    if (initialChannel) addSubscription(initialChannel, { broadcast: { self: true } }, 'query');",
    )
    changed = True

open(path, 'w', encoding='utf-8').write(text)
print('patched' if changed else 'already-current')
PY
}

patch_nginx() {
  local conf
  conf="$(find_nginx_conf || true)"
  [ -n "$conf" ] || die "nginx vhost not found for $DOMAIN; set NGINX_CONF=/path/to/${DOMAIN}.conf"
  blue "patch nginx websocket location: $conf"
  $SUDO cp -a "$conf" "${conf}.bak.$(date +%s)"
  $SUDO python3 - "$conf" "$API_PORT" <<'PY'
import os, re, sys, tempfile
path, port = sys.argv[1], sys.argv[2]
text = open(path, 'r', encoding='utf-8').read()

block = f'''
    # Pluto realtime WebSocket compatibility (/realtime/v1 and /realtime/v1/websocket)
    location ^~ /realtime/v1 {{
        proxy_pass         http://127.0.0.1:{port};
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering     off;
    }}
'''

if 'location ^~ /realtime/v1' in text:
    text = re.sub(r'\n\s*# Pluto realtime WebSocket compatibility.*?\n\s*location \^~ /realtime/v1 \{.*?\n\s*\}', '\n' + block.rstrip(), text, flags=re.S)
else:
    m = re.search(r'\n\s*location\s+/\s*\{', text)
    if not m:
        raise SystemExit('could not find generic location / block')
    text = text[:m.start()] + '\n' + block + text[m.start():]

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(text)
os.replace(tmp, path)
print('nginx-patched')
PY
  $SUDO nginx -t
  $SUDO systemctl reload nginx
  green "nginx reloaded"
}

restart_api() {
  blue "restart/rebuild Pluto API"
  if [ -f "$ROOT/docker/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
    if [ -f "$ROOT/.env" ]; then
      $SUDO docker compose --env-file "$ROOT/.env" -f "$ROOT/docker/docker-compose.yml" build api
      $SUDO docker compose --env-file "$ROOT/.env" -f "$ROOT/docker/docker-compose.yml" up -d api
      green "docker api rebuilt + restarted"
      return
    fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    unit="$(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -Ei 'pluto(-|_)?api' | head -1 || true)"
    if [ -n "$unit" ]; then
      $SUDO systemctl restart "$unit"
      green "systemd restarted: $unit"
      return
    fi
  fi
  if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -qi pluto; then
    name="$(pm2 jlist | python3 -c 'import sys,json; print(next((p["name"] for p in json.load(sys.stdin) if "pluto" in p["name"].lower()), ""))' 2>/dev/null || true)"
    [ -n "$name" ] && { pm2 restart "$name"; green "pm2 restarted: $name"; return; }
  fi
  die "could not restart API automatically; run deploy/detect-pluto-api.sh --restart"
}

verify_ws() {
  blue "verify realtime websocket handshake"
  local key="${PLUTO_ANON_KEY:-smoke_key}" headers ws_key code
  headers="$(mktemp)"
  ws_key="$(openssl rand -base64 16 2>/dev/null || date +%s | sha256sum | awk '{print $1}')"
  curl -sS -D "$headers" -o /dev/null --http1.1 --max-time 8 \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H "Sec-WebSocket-Key: $ws_key" \
    -H 'Sec-WebSocket-Version: 13' \
    "https://${DOMAIN}/realtime/v1?apikey=${key}&channel=home-content-all" >/dev/null 2>&1 || true
  code="$(awk 'toupper($0) ~ /^HTTP\// {print $2}' "$headers" | tail -1)"
  cat "$headers" | sed -n '1,8p'
  rm -f "$headers"
  [ "$code" = "101" ] || die "WebSocket handshake still failed (HTTP ${code:-none})"
  green "WebSocket handshake OK (101)"
}

patch_realtime_route
restart_api
patch_nginx
verify_ws

green "realtime repair completed for https://${DOMAIN}/realtime/v1"