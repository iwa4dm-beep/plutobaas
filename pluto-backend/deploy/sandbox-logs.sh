#!/usr/bin/env bash
# Convenience wrapper around `journalctl` for pluto services.
#
# Subcommands:
#   tail            follow all pluto services (default)
#   worker          follow only pluto-sandbox-worker
#   api             follow only pluto-api
#   errors          show last hour of errors from all pluto services
#   since <spec>    e.g. `since "10 min ago"` or `since 2026-07-16`
#   grep <pattern>  filter recent logs by regex
#   health          curl worker /healthz with pretty output
#
# Examples:
#   bash deploy/sandbox-logs.sh              # follow everything
#   bash deploy/sandbox-logs.sh worker
#   bash deploy/sandbox-logs.sh errors
#   bash deploy/sandbox-logs.sh since "30 min ago"
#   bash deploy/sandbox-logs.sh grep "unpack"
#   bash deploy/sandbox-logs.sh health

set -uo pipefail
SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"

UNITS=(pluto-sandbox-worker pluto-api)
UNIT_ARGS=(); for u in "${UNITS[@]}"; do UNIT_ARGS+=(-u "$u"); done

cmd="${1:-tail}"; shift || true

case "$cmd" in
  tail|"")
    $SUDO journalctl "${UNIT_ARGS[@]}" -f -n 200 --output=short-iso
    ;;
  worker)
    $SUDO journalctl -u pluto-sandbox-worker -f -n 200 --output=short-iso
    ;;
  api)
    $SUDO journalctl -u pluto-api -f -n 200 --output=short-iso
    ;;
  errors)
    $SUDO journalctl "${UNIT_ARGS[@]}" --since "1 hour ago" -p err --no-pager
    ;;
  since)
    spec="${1:?Usage: sandbox-logs.sh since \"10 min ago\"}"
    $SUDO journalctl "${UNIT_ARGS[@]}" --since "$spec" --no-pager --output=short-iso
    ;;
  grep)
    pat="${1:?Usage: sandbox-logs.sh grep <pattern>}"
    $SUDO journalctl "${UNIT_ARGS[@]}" --since "1 hour ago" --no-pager --output=short-iso \
      | grep -Ei --color=always "$pat"
    ;;
  health)
    port="${SANDBOX_WORKER_PORT:-8787}"
    echo "▶ GET http://127.0.0.1:${port}/healthz"
    if command -v jq >/dev/null 2>&1; then
      curl -sS "http://127.0.0.1:${port}/healthz" | jq .
    else
      curl -sS "http://127.0.0.1:${port}/healthz"
      echo
    fi
    ;;
  *)
    sed -n '2,20p' "$0"; exit 2 ;;
esac
