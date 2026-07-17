#!/usr/bin/env bash
# print-sandbox-secret.sh
#
# Reads or creates the VPS sandbox-worker shared secret and prints the exact
# value to paste into Lovable Cloud → Secrets → PLUTO_SANDBOX_SECRET.
#
# Works from any directory, including:
#   sudo bash deploy/print-sandbox-secret.sh
#   sudo bash pluto-backend/deploy/print-sandbox-secret.sh
#   sudo bash /root/backend-joy/pluto-backend/deploy/print-sandbox-secret.sh

set -euo pipefail

# --- resolve real script path (follow symlinks) -----------------------------
SOURCE="${BASH_SOURCE[0]:-$0}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${ENV_FILE:-/etc/pluto/sandbox-worker.env}"
ENV_DIR="$(dirname "$ENV_FILE")"
REQUESTED_UNIT="${UNIT:-}"

value_from_file() {
  local key="$1"
  local value=""
  [ -f "$ENV_FILE" ] || { echo ""; return 0; }
  value="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  echo "$value"
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
  else
    echo "✗ Could not generate a secret: openssl, /dev/urandom, and python3 are unavailable." >&2
    exit 1
  fi
}

unit_exists() {
  local unit="$1"
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl list-unit-files "${unit}.service" --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "${unit}.service"
}

detect_unit() {
  if [ -n "$REQUESTED_UNIT" ]; then
    echo "$REQUESTED_UNIT"
    return 0
  fi
  for candidate in pluto-sandbox-worker pluto-sandbox; do
    if unit_exists "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  echo "pluto-sandbox-worker"
}

write_canonical_secret() {
  local secret="$1"
  local tmp=""

  mkdir -p "$ENV_DIR"
  tmp="$(mktemp)"

  if [ -f "$ENV_FILE" ]; then
    grep -Ev '^[[:space:]]*SANDBOX_SHARED_SECRET[[:space:]]*=' "$ENV_FILE" > "$tmp" || true
  else
    {
      echo "# Created by deploy/print-sandbox-secret.sh"
      echo "PORT=8787"
      echo "SITES_ROOT=/var/lib/pluto/sites"
      echo "SANDBOX_SITES_ROOT=/var/lib/pluto/sites"
    } > "$tmp"
  fi

  printf '\nSANDBOX_SHARED_SECRET=%s\n' "$secret" >> "$tmp"

  if getent group www-data >/dev/null 2>&1; then
    install -m 0640 -o root -g www-data "$tmp" "$ENV_FILE"
  else
    install -m 0600 -o root -g root "$tmp" "$ENV_FILE"
  fi
  rm -f "$tmp"
}

restart_worker_if_present() {
  local unit="$1"
  if unit_exists "$unit"; then
    echo "▶ restarting ${unit}.service so it loads the secret"
    if systemctl restart "$unit"; then
      echo "✓ ${unit}.service restarted"
    else
      echo "⚠ could not restart ${unit}.service — copy the secret below, then check: journalctl -u ${unit} -n 80" >&2
    fi
  else
    echo "⚠ ${unit}.service is not installed on this VPS — secret was written, but no worker was restarted" >&2
  fi
}

probe_health_if_possible() {
  local secret="$1"
  local port=""
  port="$(value_from_file SANDBOX_WORKER_PORT)"
  [ -n "$port" ] || port="$(value_from_file PORT)"
  [ -n "$port" ] || port="8787"

  command -v curl >/dev/null 2>&1 || return 0
  if curl -fsS --max-time 3 -H "x-sandbox-secret: ${secret}" "http://127.0.0.1:${port}/sandbox/health" >/dev/null 2>&1; then
    echo "✓ authenticated /sandbox/health works on 127.0.0.1:${port}"
  else
    echo "ℹ /sandbox/health did not respond yet on 127.0.0.1:${port}; this is OK if the worker is not installed/running."
  fi
}

suggest_run_command() {
  if [[ "$SCRIPT_DIR" == "$(pwd)"* ]]; then
    printf 'sudo bash %q\n' "${SCRIPT_DIR#$(pwd)/}/$(basename "$SOURCE")"
  else
    printf 'sudo bash %q\n' "$SCRIPT_DIR/$(basename "$SOURCE")"
  fi
}

# --- must be root -----------------------------------------------------------
if [ "$(id -u)" != "0" ]; then
  echo "✗ This script must run as root because it reads/writes $ENV_FILE."
  echo "  Run: $(suggest_run_command)"
  exit 1
fi

UNIT="$(detect_unit)"

echo "▶ script dir : $SCRIPT_DIR"
echo "▶ repo root  : $REPO_ROOT"
echo "▶ env file   : $ENV_FILE"
echo "▶ unit       : $UNIT"
echo

# Prefer the canonical worker variable, but also recover from older names that
# appeared in previous installer output.
SECRET="$(value_from_file SANDBOX_SHARED_SECRET)"
SOURCE_KEY="SANDBOX_SHARED_SECRET"
if [ -z "$SECRET" ]; then
  SECRET="$(value_from_file PLUTO_SANDBOX_SECRET)"
  SOURCE_KEY="PLUTO_SANDBOX_SECRET"
fi
if [ -z "$SECRET" ]; then
  SECRET="$(value_from_file PLUTO_SANDBOX_WORKER_SECRET)"
  SOURCE_KEY="PLUTO_SANDBOX_WORKER_SECRET"
fi

GENERATED=0
if [ -z "$SECRET" ]; then
  SECRET="$(generate_secret)"
  SOURCE_KEY="generated"
  GENERATED=1
fi

write_canonical_secret "$SECRET"
echo "✓ SANDBOX_SHARED_SECRET is present in $ENV_FILE (${SOURCE_KEY})"
restart_worker_if_present "$UNIT"
probe_health_if_possible "$SECRET"
echo

# --- print result -----------------------------------------------------------
echo "==================== COPY THIS VALUE ===================="
echo "$SECRET"
echo "========================================================="
echo
echo "Lovable Cloud Secret entry:"
echo "  Name : PLUTO_SANDBOX_SECRET"
echo "  Value: $SECRET"
echo
echo "Copy-paste shell line:"
printf "  export PLUTO_SANDBOX_SECRET=%q\n" "$SECRET"
echo
echo "Next steps:"
echo "  1. Open Lovable Cloud → Secrets"
echo "  2. Add/update PLUTO_SANDBOX_SECRET with the Value above"
echo "  3. Save, then re-run Auto Deploy"
if [ "$GENERATED" = "1" ]; then
  echo
  echo "ℹ A new secret was generated on this VPS. Any older Lovable Cloud value is stale."
fi
