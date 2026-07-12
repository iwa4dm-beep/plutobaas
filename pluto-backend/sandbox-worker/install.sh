#!/usr/bin/env bash
# One-shot installer for the Pluto Sandbox Worker on a VPS (Debian/Ubuntu).
#
# Usage (as root):
#   sudo bash install.sh
#
# What it does:
#   1. Installs Node.js 20 + unzip if missing.
#   2. Copies sandbox-worker.mjs to /opt/pluto/sandbox-worker/.
#   3. Writes /etc/pluto/sandbox-worker.env (prompts for missing vars).
#   4. Installs + enables the pluto-sandbox systemd service.
#   5. Creates /var/lib/pluto/sites (owned by www-data).
#   6. Prints next steps for nginx + certbot.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo)"; exit 1; fi

echo "▶ installing dependencies (node, unzip)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y unzip

echo "▶ installing worker files"
install -d -m 0755 /opt/pluto/sandbox-worker
install -m 0755 "$HERE/sandbox-worker.mjs" /opt/pluto/sandbox-worker/sandbox-worker.mjs

echo "▶ preparing sites root"
install -d -o www-data -g www-data -m 0755 /var/lib/pluto/sites

echo "▶ writing /etc/pluto/sandbox-worker.env (secrets)"
install -d -m 0750 /etc/pluto
ENV_FILE=/etc/pluto/sandbox-worker.env
if [ ! -f "$ENV_FILE" ]; then
  read -rp "PLUTO_UPSTREAM_URL [http://127.0.0.1:8000]: " UP; UP="${UP:-http://127.0.0.1:8000}"
  read -rp "PLUTO_SERVICE_ROLE_KEY (paste the same value the Lovable app uses): " KEY
  read -rp "SANDBOX_SHARED_SECRET (leave blank to auto-generate): " SEC
  if [ -z "$SEC" ]; then SEC="$(openssl rand -hex 32)"; fi
  cat > "$ENV_FILE" <<EOF
PORT=8787
PLUTO_UPSTREAM_URL=$UP
PLUTO_SERVICE_ROLE_KEY=$KEY
SANDBOX_SHARED_SECRET=$SEC
SITES_ROOT=/var/lib/pluto/sites
EOF
  chmod 0640 "$ENV_FILE"
  chown root:www-data "$ENV_FILE"
  echo "✓ wrote $ENV_FILE"
  echo
  echo "⚠ COPY THIS SECRET INTO LOVABLE (Cloud → Secrets):"
  echo "    PLUTO_SANDBOX_URL     = http://127.0.0.1:8787   (if the Lovable server runs on this VPS)"
  echo "    PLUTO_SANDBOX_URL     = https://sandbox.<your-vps-host>   (if remote — expose via nginx + auth)"
  echo "    PLUTO_SANDBOX_SECRET  = $SEC"
  echo
else
  echo "✓ $ENV_FILE already exists — leaving it alone"
fi

echo "▶ installing systemd unit"
install -m 0644 "$HERE/pluto-sandbox.service" /etc/systemd/system/pluto-sandbox.service
systemctl daemon-reload
systemctl enable --now pluto-sandbox.service
sleep 1
systemctl --no-pager status pluto-sandbox.service | head -n 12 || true

echo
echo "✅ pluto-sandbox worker installed."
echo
echo "Next steps:"
echo "  1. Test it locally:"
echo "       curl http://127.0.0.1:8787/healthz"
echo "  2. Copy nginx-app.conf → /etc/nginx/sites-available/app.timescard.cloud"
echo "     replace <WORKSPACE_ID> with your workspace UUID, then:"
echo "       ln -s /etc/nginx/sites-available/app.timescard.cloud /etc/nginx/sites-enabled/"
echo "       nginx -t && systemctl reload nginx"
echo "       certbot --nginx -d app.timescard.cloud"
echo "  3. In Lovable Cloud, add secrets PLUTO_SANDBOX_URL + PLUTO_SANDBOX_SECRET,"
echo "     then re-run 'Deploy to VPS' — the new 'unpack-serve' step will go live."
