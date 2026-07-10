#!/usr/bin/env bash
# Install backup scripts + systemd unit + timer + secret files.
# Run as root on the VPS.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="/opt/pluto/deploy"

install -d -m 0755 "$DST/backup"
install -m 0755 "$SRC/backup/"*.sh "$DST/backup/"

install -m 0644 "$SRC/systemd/pluto-backup.service" /etc/systemd/system/
install -m 0644 "$SRC/systemd/pluto-backup.timer"   /etc/systemd/system/

# Non-secret config
if [ ! -f /etc/pluto-backup.env ]; then
  cat > /etc/pluto-backup.env <<'EOF'
BACKUP_DIR=/var/backups/pluto
PROJECT_DIR=/root/backend-joy
PG_CONTAINER=pluto-postgres
PG_USER=pluto
PG_DB=pluto
KEEP=14
ENCRYPT=1
EOF
  chmod 0644 /etc/pluto-backup.env
  echo "wrote /etc/pluto-backup.env  (edit as needed)"
fi

# Secret passphrase — generate once if missing, lock down perms.
if [ ! -f /etc/pluto-backup.secret ]; then
  PASS=$(openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-40)
  umask 077
  printf 'BACKUP_PASSPHRASE=%s\n' "$PASS" > /etc/pluto-backup.secret
  chmod 0600 /etc/pluto-backup.secret
  chown root:root /etc/pluto-backup.secret
  echo "generated /etc/pluto-backup.secret (mode 0600, root only)"
  echo ""
  echo "⚠  STORE THIS PASSPHRASE SOMEWHERE SAFE — you need it to decrypt backups:"
  echo "   $PASS"
  echo ""
fi

systemctl daemon-reload
systemctl enable --now pluto-backup.timer
systemctl list-timers pluto-backup.timer --no-pager
echo "✔ installed. run once now:  systemctl start pluto-backup.service"
echo "  logs:                      journalctl -u pluto-backup -f"
echo "                             tail -f /var/log/pluto-backup/backup-*.log"
