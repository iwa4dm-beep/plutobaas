#!/usr/bin/env bash
# Discover how `pluto-api` is running on this VPS and print the correct
# restart command. Handles: systemd unit, pm2 process, docker container,
# raw node process. Safe read-only — never restarts anything.
#
# Usage:
#   bash pluto-backend/deploy/detect-pluto-api.sh
#   bash pluto-backend/deploy/detect-pluto-api.sh --restart   # actually restart

set -uo pipefail

RESTART=0
[ "${1:-}" = "--restart" ] && RESTART=1

SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"

hr() { printf -- "─%.0s" {1..60}; echo; }
say() { printf "▶ %s\n" "$*"; }
ok()  { printf "✓ %s\n" "$*"; }
bad() { printf "✗ %s\n" "$*"; }

found_cmd=""

# 1) systemd -------------------------------------------------------------
say "Scanning systemd for pluto-api units…"
UNITS="$(systemctl list-unit-files --type=service --no-legend 2>/dev/null \
        | awk '{print $1}' | grep -Ei 'pluto(-|_)?api' || true)"
if [ -n "$UNITS" ]; then
  for u in $UNITS; do
    state="$(systemctl is-active "$u" 2>/dev/null || echo unknown)"
    ok "systemd unit: $u  (state=$state)"
    [ -z "$found_cmd" ] && found_cmd="$SUDO systemctl restart $u"
  done
fi

# 2) pm2 -----------------------------------------------------------------
if command -v pm2 >/dev/null 2>&1; then
  say "Scanning pm2 list for pluto-api…"
  PM2="$(pm2 jlist 2>/dev/null || echo '[]')"
  if echo "$PM2" | grep -qi 'pluto'; then
    NAME="$(echo "$PM2" | python3 -c 'import sys,json;[print(p["name"]) for p in json.load(sys.stdin) if "pluto" in p["name"].lower()]' 2>/dev/null | head -1)"
    [ -n "$NAME" ] && { ok "pm2 process: $NAME"; [ -z "$found_cmd" ] && found_cmd="pm2 restart $NAME"; }
  fi
fi

# 3) docker --------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  say "Scanning docker containers for pluto-api…"
  DC="$($SUDO docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null | grep -Ei 'pluto(-|_)?api' || true)"
  if [ -n "$DC" ]; then
    NAME="$(echo "$DC" | head -1 | awk '{print $1}')"
    ok "docker container: $DC"
    [ -z "$found_cmd" ] && found_cmd="$SUDO docker restart $NAME"
  fi
fi

# 4) Raw node process ----------------------------------------------------
say "Scanning process list for a bare node process…"
PROC="$(ps -eo pid,cmd 2>/dev/null | grep -Ei 'pluto[-_]?api|pluto-backend/(server|api|dist)' | grep -v grep || true)"
if [ -n "$PROC" ]; then
  echo "$PROC" | sed 's/^/    /'
  [ -z "$found_cmd" ] && found_cmd="# raw node process — kill the PID above and re-run your start script"
fi

# 5) Port hint -----------------------------------------------------------
if command -v ss >/dev/null 2>&1; then
  say "Listening sockets on typical pluto-api ports (8000/3000/4000/8080)…"
  $SUDO ss -ltnp 2>/dev/null | grep -E ':(8000|3000|4000|8080)\b' || echo "    (none)"
fi

hr
if [ -n "$found_cmd" ]; then
  ok "Detected pluto-api runner. Restart command:"
  echo
  echo "    $found_cmd"
  echo
  if [ $RESTART -eq 1 ] && ! echo "$found_cmd" | grep -q '^#'; then
    say "Executing restart…"
    eval "$found_cmd"
    ok "Restart issued. Verify with:  bash $(dirname "$0")/sandbox-logs.sh health"
  fi
else
  bad "No pluto-api runner detected."
  echo "   • If you start it manually from a shell/tmux, restart it there."
  echo "   • If it should be a systemd unit, install one from"
  echo "     pluto-backend/deploy/systemd/ and enable pluto-api.service."
fi
