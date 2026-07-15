#!/usr/bin/env bash
# One-command installer for pluto-sandbox on a fresh VPS.
#
# Usage (as root on the VPS):
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/pluto-backend/sandbox-worker/one-command-install.sh | sudo bash
# or, if the repo is already cloned:
#   sudo bash pluto-backend/sandbox-worker/one-command-install.sh
#
# What it does:
#   1. Finds (or clones) the repo containing pluto-backend/sandbox-worker/
#   2. Removes any stale /etc/pluto-sandbox/ config from earlier attempts
#   3. Runs install.sh non-interactively (uses env vars or auto-generates the secret)
#   4. Writes /etc/pluto/sandbox-worker.env with the correct variable names
#   5. Enables + starts pluto-sandbox.service
#   6. Verifies http://127.0.0.1:8787/healthz responds 200
#
# Non-interactive overrides (optional — export before running):
#   PLUTO_UPSTREAM_URL         default: http://127.0.0.1:8000
#   PLUTO_SERVICE_ROLE_KEY     default: "" (leave blank if only static hosting is needed)
#   SANDBOX_SHARED_SECRET      default: auto-generated with openssl rand -hex 32
#   REPO_URL                   default: https://github.com/lovable-dev/backend-joy.git
#   REPO_DIR                   default: /root/backend-joy

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "✘ run as root (sudo bash $0)"; exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/lovable-dev/backend-joy.git}"
REPO_DIR="${REPO_DIR:-/root/backend-joy}"
PLUTO_UPSTREAM_URL="${PLUTO_UPSTREAM_URL:-http://127.0.0.1:8000}"
PLUTO_SERVICE_ROLE_KEY="${PLUTO_SERVICE_ROLE_KEY:-}"
SANDBOX_SHARED_SECRET="${SANDBOX_SHARED_SECRET:-}"

echo "▶ [1/6] locating sandbox-worker/ in the repo"
CANDIDATES=(
  "$(pwd)/pluto-backend/sandbox-worker"
  "$REPO_DIR/pluto-backend/sandbox-worker"
  "/root/backend-joy/pluto-backend/sandbox-worker"
  "/root/pluto-backend/sandbox-worker"
  "/opt/backend-joy/pluto-backend/sandbox-worker"
)
WORKER_DIR=""
for c in "${CANDIDATES[@]}"; do
  if [ -f "$c/install.sh" ] && [ -f "$c/sandbox-worker.mjs" ]; then
    WORKER_DIR="$c"; break
  fi
done

if [ -z "$WORKER_DIR" ]; then
  echo "  repo not found locally — cloning $REPO_URL → $REPO_DIR"
  apt-get update -y >/dev/null
  apt-get install -y git >/dev/null
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" pull --ff-only || true
  else
    git clone --depth 1 "$REPO_URL" "$REPO_DIR"
  fi
  WORKER_DIR="$REPO_DIR/pluto-backend/sandbox-worker"
fi

if [ ! -f "$WORKER_DIR/install.sh" ]; then
  echo "✘ could not find $WORKER_DIR/install.sh — set REPO_URL/REPO_DIR and retry"; exit 1
fi
echo "  ✓ using $WORKER_DIR"

echo "▶ [2/6] removing stale /etc/pluto-sandbox/ (wrong path from earlier attempts)"
rm -rf /etc/pluto-sandbox

echo "▶ [3/6] generating secret if none provided"
if [ -z "$SANDBOX_SHARED_SECRET" ]; then
  SANDBOX_SHARED_SECRET="$(openssl rand -hex 32)"
fi

echo "▶ [4/6] writing /etc/pluto/sandbox-worker.env (correct path + variable names)"
install -d -m 0750 /etc/pluto
cat > /etc/pluto/sandbox-worker.env <<EOF
PORT=8787
PLUTO_UPSTREAM_URL=$PLUTO_UPSTREAM_URL
PLUTO_SERVICE_ROLE_KEY=$PLUTO_SERVICE_ROLE_KEY
SANDBOX_SHARED_SECRET=$SANDBOX_SHARED_SECRET
SITES_ROOT=/var/lib/pluto/sites
EOF
chmod 0640 /etc/pluto/sandbox-worker.env
chown root:www-data /etc/pluto/sandbox-worker.env 2>/dev/null || true

echo "▶ [5/6] installing worker + systemd unit"
# install.sh sees an existing env file and skips its own prompts.
bash "$WORKER_DIR/install.sh"

echo "▶ [6/6] verifying"
systemctl enable --now pluto-sandbox.service
sleep 2
systemctl --no-pager status pluto-sandbox.service | head -n 10 || true

set +e
CODE=$(curl -s -o /tmp/pluto-healthz.out -w '%{http_code}' http://127.0.0.1:8787/healthz)
set -e
echo
if [ "$CODE" = "200" ]; then
  echo "✅ pluto-sandbox is live on http://127.0.0.1:8787"
else
  echo "⚠  /healthz returned HTTP $CODE — check: journalctl -u pluto-sandbox -n 50"
fi
cat /tmp/pluto-healthz.out 2>/dev/null; echo

echo
echo "═══════════════════════════════════════════════════════════════"
echo " COPY THESE INTO LOVABLE (Cloud → Secrets):"
echo "   PLUTO_SANDBOX_URL     = https://app.timescard.cloud"
echo "   PLUTO_SANDBOX_SECRET  = $SANDBOX_SHARED_SECRET"
echo "═══════════════════════════════════════════════════════════════"
