#!/usr/bin/env bash
# refresh-worker.sh — force the running pluto-sandbox-worker to pick up the
# latest sandbox-worker.mjs from this repo. Fixes the "worker restarted but
# still serves old code" case (401 on /sites/, /preview/, /site-status/).
#
# What it does:
#   1. Locates the systemd unit (pluto-sandbox-worker | pluto-sandbox).
#   2. Reads ExecStart to find the ACTUAL mjs path the service runs.
#   3. Copies repo sandbox-worker/sandbox-worker.mjs to that path (and to the
#      canonical /opt/pluto/sandbox-worker/ location as a fallback).
#   4. Verifies SHA-256 matches after copy.
#   5. Kills any stray `node sandbox-worker.mjs` processes not owned by systemd.
#   6. Restarts the unit and probes /healthz for the "v1-static-serve" marker.
#
# Usage:  sudo bash deploy/refresh-worker.sh

set -uo pipefail
cd "$(dirname "$0")/.."
REPO_MJS="$(pwd)/sandbox-worker/sandbox-worker.mjs"
[ -f "$REPO_MJS" ] || { echo "✗ repo file missing: $REPO_MJS"; exit 2; }

[ "$(id -u)" -eq 0 ] || { echo "✗ run as root"; exit 2; }

# 1. Pick unit.
UNIT=""
for u in pluto-sandbox-worker pluto-sandbox; do
  if systemctl list-unit-files "${u}.service" >/dev/null 2>&1; then UNIT="$u"; break; fi
done
[ -n "$UNIT" ] || { echo "✗ no pluto-sandbox[-worker] unit found"; exit 2; }
echo "▶ unit: $UNIT"

# 2. Read ExecStart.
EXEC="$(systemctl show -p ExecStart --value "$UNIT" 2>/dev/null | tr -d '\n')"
echo "  ExecStart raw: $EXEC"
# path is usually /usr/bin/node /opt/pluto/sandbox-worker/sandbox-worker.mjs
RUN_MJS="$(printf '%s' "$EXEC" | grep -oE '/[^ ;{}]+sandbox-worker\.mjs' | head -1)"
[ -n "$RUN_MJS" ] || RUN_MJS="/opt/pluto/sandbox-worker/sandbox-worker.mjs"
echo "  running mjs:  $RUN_MJS"

# 3. Copy to both the running location and the canonical one.
mkdir -p "$(dirname "$RUN_MJS")" /opt/pluto/sandbox-worker
install -m 0755 "$REPO_MJS" "$RUN_MJS"
install -m 0755 "$REPO_MJS" /opt/pluto/sandbox-worker/sandbox-worker.mjs
echo "✓ copied to $RUN_MJS and /opt/pluto/sandbox-worker/sandbox-worker.mjs"

# 4. Checksum verify.
SRC_SUM=$(sha256sum "$REPO_MJS"     | awk '{print $1}')
DST_SUM=$(sha256sum "$RUN_MJS"      | awk '{print $1}')
if [ "$SRC_SUM" != "$DST_SUM" ]; then
  echo "✗ checksum mismatch after copy — filesystem or path issue"; exit 1
fi
echo "  sha256: $SRC_SUM"

# 5. Kill stray node processes running an OLD mjs path.
STRAY="$(pgrep -af 'node .*sandbox-worker\.mjs' | grep -v " $RUN_MJS" || true)"
if [ -n "$STRAY" ]; then
  echo "⚠ stray worker processes not tied to $RUN_MJS:"
  echo "$STRAY"
  echo "  killing…"
  pkill -f 'node .*sandbox-worker\.mjs' || true
  sleep 1
fi

# 6. Restart + probe.
systemctl restart "$UNIT" || { echo "✗ restart failed"; systemctl status "$UNIT" --no-pager -l; exit 1; }
sleep 2
PORT="$(grep -E '^(SANDBOX_WORKER_)?PORT=' /etc/pluto/sandbox-worker.env 2>/dev/null | tail -1 | cut -d= -f2)"
PORT="${PORT:-8787}"
BODY="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" || echo '')"
echo "  /healthz: $BODY"
if echo "$BODY" | grep -q 'v1-static-serve'; then
  echo "✓ worker now running fresh code (version marker present)"
else
  echo "✗ /healthz missing 'v1-static-serve' marker — still stale."
  echo "  Check:  systemctl cat $UNIT   |  ls -la $RUN_MJS  |  head -5 $RUN_MJS"
  exit 1
fi

# 7. Sanity: /sites/ probe should be 404 (public) not 401 for a nonexistent slug.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/sites/__probe__/") || CODE=000
echo "  /sites/__probe__/ → HTTP $CODE  (expect 404, NOT 401)"
[ "$CODE" = "404" ] && echo "✓ public /sites/ route active" || echo "⚠ /sites/ still not public ($CODE)"
