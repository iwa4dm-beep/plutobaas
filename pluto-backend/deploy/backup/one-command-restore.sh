#!/usr/bin/env bash
# One-command VPS restore:
#   upload ZIP → extract → restore configs → restore DB → restart services
#   with automatic pre-restore snapshot for rollback.
#
# Usage (run ON THE VPS):
#   bash one-command-restore.sh <pluto-complete-*.zip[.enc]> [pluto-db-*.dump[.enc]] [pluto-config-*.tar.gz[.enc]]
#
# Env:
#   PROJECT_DIR         default /root/backend-joy
#   PG_CONTAINER        default pluto-postgres
#   PG_USER / PG_DB     default pluto / pluto
#   BACKUP_PASSPHRASE   required if any file ends in .enc
#   ROLLBACK=1          if set, restores the latest pre-restore snapshot instead
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/backend-joy}"
PG_CONTAINER="${PG_CONTAINER:-pluto-postgres}"
PG_USER="${PG_USER:-pluto}"
PG_DB="${PG_DB:-pluto}"
SNAP_DIR="/var/backups/pluto/rollback"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$SNAP_DIR"

C_G='\033[1;32m'; C_R='\033[1;31m'; C_Y='\033[1;33m'; C_0='\033[0m'
say() { printf "${C_Y}▶ %s${C_0}\n" "$*"; }
ok()  { printf "${C_G}  ✔ %s${C_0}\n" "$*"; }
die() { printf "${C_R}  ✘ %s${C_0}\n" "$*"; exit 1; }

decrypt_if_needed() {
  local f="$1"
  case "$f" in
    *.enc)
      [ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE লাগবে (.enc ফাইলের জন্য)"
      local out="${f%.enc}"
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -in "$f" -out "$out" -pass env:BACKUP_PASSPHRASE || die "decrypt failed: $f"
      echo "$out" ;;
    *) echo "$f" ;;
  esac
}

# ── rollback path ────────────────────────────────────────────────
if [ "${ROLLBACK:-0}" = "1" ]; then
  say "ROLLBACK: reverting to latest snapshot in $SNAP_DIR"
  LATEST=$(ls -1t "$SNAP_DIR"/snap-*.tar.gz 2>/dev/null | head -1)
  LATEST_DB=$(ls -1t "$SNAP_DIR"/snap-*.dump 2>/dev/null | head -1)
  [ -n "$LATEST" ] || die "no rollback snapshot found"
  tar xzf "$LATEST" -C /
  [ -n "$LATEST_DB" ] && docker exec -i "$PG_CONTAINER" \
    pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists < "$LATEST_DB"
  systemctl restart pluto-backend nginx || true
  ok "rollback complete ($LATEST)"; exit 0
fi

ZIP="${1:?usage: $0 <zip> [db.dump] [config.tar.gz]}"
DB="${2:-}"
CFG="${3:-}"
[ -f "$ZIP" ] || die "zip not found: $ZIP"

# ── 1. pre-restore snapshot for rollback ─────────────────────────
say "1/6  taking pre-restore snapshot → $SNAP_DIR/snap-$STAMP.*"
tar czf "$SNAP_DIR/snap-$STAMP.tar.gz" \
  /etc/nginx/sites-available /etc/nginx/sites-enabled \
  /etc/systemd/system/pluto-*.service /etc/systemd/system/pluto-*.timer \
  "$PROJECT_DIR/pluto-backend/.env" 2>/dev/null || true
docker exec -i "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -F c -Z 9 \
  > "$SNAP_DIR/snap-$STAMP.dump" 2>/dev/null || echo "   (DB snapshot skipped)"
ok "snapshot saved (rollback: ROLLBACK=1 bash $0)"

# ── 2. decrypt if needed ─────────────────────────────────────────
say "2/6  decrypting (if .enc)"
ZIP=$(decrypt_if_needed "$ZIP")
[ -n "$DB" ]  && DB=$(decrypt_if_needed "$DB")
[ -n "$CFG" ] && CFG=$(decrypt_if_needed "$CFG")
ok "ready: $ZIP"

# ── 3. extract source ────────────────────────────────────────────
say "3/6  extracting source zip"
TMP="/tmp/pluto-restore-$STAMP"; mkdir -p "$TMP"
unzip -q "$ZIP" -d "$TMP" || die "unzip failed"
SRC=$(find "$TMP" -maxdepth 2 -name pluto-backend -type d | head -1)
[ -n "$SRC" ] || SRC=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)
[ -d "$PROJECT_DIR" ] && mv "$PROJECT_DIR" "$PROJECT_DIR.old-$STAMP"
mkdir -p "$(dirname "$PROJECT_DIR")"
mv "$(dirname "$SRC")" "$PROJECT_DIR" 2>/dev/null || mv "$SRC" "$PROJECT_DIR"
ok "extracted → $PROJECT_DIR"

# ── 4. restore server configs ────────────────────────────────────
if [ -n "$CFG" ] && [ -f "$CFG" ]; then
  say "4/6  restoring server configs"
  tar xzf "$CFG" -C / && systemctl daemon-reload
  ok "configs restored"
else
  say "4/6  skipping configs (no tarball given)"
fi

# ── 5. restore DB (with pg_restore --list verify first) ──────────
if [ -n "$DB" ] && [ -f "$DB" ]; then
  say "5/6  verifying DB dump before restoring"
  pg_restore --list "$DB" >/dev/null || die "dump is corrupt — aborting"
  ok "dump readable"
  say "     restoring into $PG_DB"
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" \
    --clean --if-exists --no-owner --no-privileges < "$DB" || die "pg_restore failed"
  ok "DB restored"
else
  say "5/6  skipping DB (no dump given)"
fi

# ── 6. restart services + health probe ───────────────────────────
say "6/6  restarting services"
systemctl daemon-reload
systemctl restart pluto-backend 2>/dev/null || true
systemctl reload  nginx         2>/dev/null || true

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/v1/health >/dev/null 2>&1; then
    ok "API healthy after ${i}s"; break
  fi
  sleep 2
  [ "$i" = 30 ] && die "API did not become healthy — run: ROLLBACK=1 bash $0"
done

echo
printf "${C_G}✅ Restore complete.${C_0}\n"
echo "   rollback available:  ROLLBACK=1 bash $0"
echo "   old project kept at: $PROJECT_DIR.old-$STAMP"
