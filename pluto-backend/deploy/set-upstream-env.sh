#!/usr/bin/env bash
# set-upstream-env.sh — rewrite PLUTO_UPSTREAM_URL in /etc/pluto/sandbox-worker.env,
# restart the sandbox worker, and verify /healthz reports the new upstream.
#
# Invoked by /usr/local/sbin/pluto-repair (action: set-upstream) which is
# sudo-run by the sandbox worker on behalf of Lovable Cloud's authenticated
# POST /admin/env/set-upstream (via runVpsRepair server function).
#
# Env in:
#   UPSTREAM        required — e.g. https://abcd1234.supabase.co
#   ENV_FILE        default /etc/pluto/sandbox-worker.env
#   UNIT            default auto-detect pluto-sandbox-worker | pluto-sandbox
#   PORT            default 8787
set -uo pipefail

ENV_FILE="${ENV_FILE:-/etc/pluto/sandbox-worker.env}"
UNIT="${UNIT:-}"
PORT="${PORT:-8787}"
UPSTREAM="${UPSTREAM:-}"

if [ -z "$UPSTREAM" ]; then
  echo "✗ UPSTREAM env var is required (e.g. https://abcd1234.supabase.co)"; exit 2
fi

# Reject placeholders and malformed URLs (same rules as the worker's pickStorageBase).
if echo "$UPSTREAM" | grep -qiE '<[^>]+>|your-project|example\.com|placeholder|supabase-ref'; then
  echo "✗ UPSTREAM looks like a placeholder: $UPSTREAM"; exit 2
fi
if ! echo "$UPSTREAM" | grep -qE '^https?://[A-Za-z0-9._-]+(:[0-9]+)?(/.*)?$'; then
  echo "✗ UPSTREAM is not a valid http(s) URL: $UPSTREAM"; exit 2
fi

# Detect unit if the caller didn't force one.
if [ -z "$UNIT" ]; then
  if systemctl list-unit-files pluto-sandbox-worker.service >/dev/null 2>&1; then
    UNIT="pluto-sandbox-worker"
  elif systemctl list-unit-files pluto-sandbox.service >/dev/null 2>&1; then
    UNIT="pluto-sandbox"
  else
    UNIT="pluto-sandbox-worker"
  fi
fi

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 0640 "$ENV_FILE" 2>/dev/null || true

# Rewrite (or append) PLUTO_UPSTREAM_URL atomically.
TMP="$(mktemp)"
if grep -q '^PLUTO_UPSTREAM_URL=' "$ENV_FILE" 2>/dev/null; then
  awk -v v="$UPSTREAM" '
    /^PLUTO_UPSTREAM_URL=/ { print "PLUTO_UPSTREAM_URL=" v; next }
    { print }
  ' "$ENV_FILE" > "$TMP"
else
  cat "$ENV_FILE" > "$TMP"
  echo "PLUTO_UPSTREAM_URL=${UPSTREAM}" >> "$TMP"
fi
install -m 0640 -o root -g root "$TMP" "$ENV_FILE"
rm -f "$TMP"
echo "✓ rewrote PLUTO_UPSTREAM_URL in $ENV_FILE"
grep '^PLUTO_UPSTREAM_URL=' "$ENV_FILE" | sed 's/^/  /'

echo "▶ restarting $UNIT"
systemctl restart "$UNIT" || { echo "✗ restart failed"; systemctl status "$UNIT" --no-pager -l | tail -20; exit 1; }
for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  STATE="$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
  [ "$STATE" = "activating" ] || break
done
STATE="$(systemctl is-active "$UNIT" 2>/dev/null || echo unknown)"
[ "$STATE" = "active" ] || { echo "✗ $UNIT state=$STATE"; journalctl -u "$UNIT" --no-pager -n 30; exit 1; }
echo "✓ $UNIT is active"

# Verify /healthz reports the new upstream so the caller has proof-of-fix.
sleep 1
BODY="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" || true)"
if [ -z "$BODY" ]; then
  echo "✗ worker did not respond on 127.0.0.1:${PORT}/healthz"; exit 1
fi
if echo "$BODY" | grep -qF "\"upstream\":\"${UPSTREAM}\""; then
  echo "✓ /healthz reports upstream=${UPSTREAM}"
else
  echo "⚠ /healthz responded but did not echo the new upstream — payload:"
  echo "$BODY" | head -c 400; echo
  exit 1
fi
