#!/usr/bin/env bash
# reset-sandbox-worker-port.sh — detect the owner of 127.0.0.1:8787 and safely
# recover pluto-sandbox-worker before a start/restart.
#
# Fixes: Error: listen EADDRINUSE 127.0.0.1:8787
# Usage:
#   sudo bash deploy/reset-sandbox-worker-port.sh [port]
#   sudo FORCE_PORT_TAKEOVER=1 bash deploy/reset-sandbox-worker-port.sh [port]
#
# Safety model:
#   - Always prints the process/unit owning the port before touching it.
#   - Stops/kills known Pluto sandbox units and node sandbox-worker.mjs strays.
#   - Refuses to kill unrelated software unless FORCE_PORT_TAKEOVER=1 is set.

set -uo pipefail

PORT="${1:-${PORT:-8787}}"
TARGET_UNIT="${UNIT:-pluto-sandbox-worker}"
FORCE_PORT_TAKEOVER="${FORCE_PORT_TAKEOVER:-${FORCE:-0}}"
SKIP_TARGET_STOP="${SKIP_TARGET_STOP:-0}"

[ "$(id -u)" -eq 0 ] || { echo "✗ run as root"; exit 2; }

unit_exists() {
  systemctl list-unit-files "${1}.service" >/dev/null 2>&1 || systemctl status "$1" >/dev/null 2>&1
}

listener_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltnp "sport = :${PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$PORT" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
  fi
}

pid_unit() {
  local pid="$1"
  [ -r "/proc/${pid}/cgroup" ] || return 0
  sed -n 's#.*system\.slice/\([^/]*\.service\).*#\1#p' "/proc/${pid}/cgroup" | head -1
}

pid_args() {
  local pid="$1"
  ps -o args= -p "$pid" 2>/dev/null || true
}

print_pid() {
  local pid="$1" unit args
  unit="$(pid_unit "$pid")"
  args="$(pid_args "$pid")"
  printf '  pid=%s unit=%s cmd=%s\n' "$pid" "${unit:-unknown}" "${args:-unknown}"
}

is_sandbox_pid() {
  local pid="$1" unit args
  unit="$(pid_unit "$pid")"
  args="$(pid_args "$pid")"
  case "$unit" in
    pluto-sandbox-worker.service|pluto-sandbox.service) return 0 ;;
  esac
  printf '%s' "$args" | grep -Eq '(^|/| )node .*sandbox-worker\.mjs|/opt/pluto/sandbox-worker|/var/lib/pluto/sandbox-worker'
}

wait_port_free() {
  local i
  for i in 1 2 3 4 5; do
    [ -z "$(listener_pids)" ] && return 0
    sleep 1
  done
  return 1
}

kill_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
}

kill9_pid() {
  local pid="$1"
  kill -9 "$pid" 2>/dev/null || true
}

echo "▶ Inspecting 127.0.0.1:${PORT} owner"
PIDS="$(listener_pids)"
if [ -n "$PIDS" ]; then
  echo "  listener(s) before recovery:"
  for pid in $PIDS; do print_pid "$pid"; done
else
  echo "  no listener currently bound to ${PORT}"
fi

echo "▶ Stopping known Pluto sandbox units"
for u in pluto-sandbox pluto-sandbox-worker; do
  if [ "$SKIP_TARGET_STOP" = "1" ] && [ "$u" = "$TARGET_UNIT" ]; then
    echo "  skipping target unit stop during ExecStartPre: ${u}.service"
    continue
  fi
  if unit_exists "$u"; then
    echo "  stopping ${u}.service"
    systemctl stop "$u" 2>/dev/null || true
    systemctl kill --kill-who=all "$u" 2>/dev/null || true
    systemctl reset-failed "$u" 2>/dev/null || true
  fi
done

wait_port_free || true
PIDS="$(listener_pids)"
if [ -n "$PIDS" ]; then
  echo "▶ Port still busy; evaluating listener safety"
  BLOCKED=""
  KILLABLE=""
  for pid in $PIDS; do
    print_pid "$pid"
    if is_sandbox_pid "$pid" || [ "$FORCE_PORT_TAKEOVER" = "1" ]; then
      KILLABLE="${KILLABLE} ${pid}"
    else
      BLOCKED="${BLOCKED} ${pid}"
    fi
  done

  if [ -n "$BLOCKED" ] && [ "$FORCE_PORT_TAKEOVER" != "1" ]; then
    echo "✗ port ${PORT} is owned by non-Pluto process(es):${BLOCKED}"
    echo "  Refusing to kill unrelated software. If 8787 is dedicated to Pluto on this VPS, rerun:"
    echo "  sudo FORCE_PORT_TAKEOVER=1 bash deploy/reset-sandbox-worker-port.sh ${PORT}"
    exit 1
  fi

  if [ -n "$KILLABLE" ]; then
    echo "▶ Releasing port ${PORT} from pid(s):${KILLABLE}"
    for pid in $KILLABLE; do kill_pid "$pid"; done
    sleep 1
    for pid in $KILLABLE; do kill9_pid "$pid"; done
  fi
fi

# Clean up sandbox-worker strays even if they are no longer the listener. This
# prevents a legacy unit/process from immediately racing the new service again.
STRAYS="$(pgrep -af 'node .*sandbox-worker\.mjs' 2>/dev/null | awk '{print $1}' | sort -u || true)"
if [ -n "$STRAYS" ]; then
  echo "▶ Killing stray sandbox-worker.mjs process(es): $STRAYS"
  for pid in $STRAYS; do print_pid "$pid"; kill_pid "$pid"; done
  sleep 1
  for pid in $STRAYS; do kill9_pid "$pid"; done
fi

if ! wait_port_free; then
  echo "✗ port ${PORT} is still busy after recovery:"
  if command -v ss >/dev/null 2>&1; then ss -ltnp "sport = :${PORT}" || true; fi
  for pid in $(listener_pids); do print_pid "$pid"; done
  exit 1
fi

echo "✓ port ${PORT} is free"