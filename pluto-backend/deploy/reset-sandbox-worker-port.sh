#!/usr/bin/env bash
# reset-sandbox-worker-port.sh — hard reset sandbox worker restart loops.
#
# Fixes: Error: listen EADDRINUSE 127.0.0.1:8787
# Usage: sudo bash deploy/reset-sandbox-worker-port.sh [port]

set -uo pipefail

PORT="${1:-${PORT:-8787}}"
[ "$(id -u)" -eq 0 ] || { echo "✗ run as root"; exit 2; }

echo "▶ Hard-stopping sandbox worker units"
for u in pluto-sandbox-worker pluto-sandbox; do
  if systemctl list-unit-files "${u}.service" >/dev/null 2>&1 || systemctl status "$u" >/dev/null 2>&1; then
    systemctl stop "$u" 2>/dev/null || true
    systemctl kill --kill-who=all "$u" 2>/dev/null || true
    systemctl reset-failed "$u" 2>/dev/null || true
  fi
done

echo "▶ Killing any process listening on 127.0.0.1:${PORT}"
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
fi

if command -v ss >/dev/null 2>&1; then
  PIDS="$(ss -H -ltnp "sport = :${PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  if [ -n "$PIDS" ]; then
    echo "  listener pid(s): $PIDS"
    echo "$PIDS" | xargs -r kill 2>/dev/null || true
    sleep 1
    echo "$PIDS" | xargs -r kill -9 2>/dev/null || true
  fi
fi

pkill -f 'node .*sandbox-worker\.mjs' 2>/dev/null || true
sleep 1

if command -v ss >/dev/null 2>&1 && ss -H -ltn "sport = :${PORT}" | grep -q .; then
  echo "✗ port ${PORT} is still busy:"
  ss -ltnp "sport = :${PORT}" || true
  exit 1
fi

echo "✓ port ${PORT} is free"