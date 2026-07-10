#!/usr/bin/env bash
# VPS-side daily backup:
#   1. slim source zip (frontend+backend+server configs, excludes junk)
#   2. postgres dump from running container (custom format, gzip-9)
#   3. server config tarball (nginx, systemd, letsencrypt, .env)
#   4. SHA256 sidecars + manifest.json per run
#   5. optional AES-256 encryption using key from systemd env / secret file
#   6. auto restore-verify via `pg_restore --list`
#   7. prune to newest N of each artifact type
#
# Env (systemd EnvironmentFile=/etc/pluto-backup.env):
#   BACKUP_DIR         default /var/backups/pluto
#   PROJECT_DIR        default /root/backend-joy
#   PG_CONTAINER       default pluto-postgres
#   PG_USER / PG_DB    postgres creds inside container
#   KEEP               keep newest N of each type   default 14
#   ENCRYPT            1 to encrypt zips with AES-256   default 0
#   BACKUP_PASSPHRASE  encryption passphrase (from systemd env, NEVER file)
#   BACKUP_PASSPHRASE_FILE  alternative: path readable only by root
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pluto}"
PROJECT_DIR="${PROJECT_DIR:-/root/backend-joy}"
PG_CONTAINER="${PG_CONTAINER:-pluto-postgres}"
PG_USER="${PG_USER:-pluto}"
PG_DB="${PG_DB:-pluto}"
KEEP="${KEEP:-14}"
ENCRYPT="${ENCRYPT:-0}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="/var/log/pluto-backup"
LOG="$LOG_DIR/backup-$STAMP.log"
mkdir -p "$LOG_DIR" "$BACKUP_DIR"/{zip,db,config,manifest}

# ─── logging helpers ──────────────────────────────────────────────
exec > >(tee -a "$LOG") 2>&1
log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { log "✘ FAIL: $*"; STATUS="failed"; }
STATUS="ok"

# ─── resolve passphrase (env > file > none) ───────────────────────
PASS=""
if [ "$ENCRYPT" = "1" ]; then
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    PASS="$BACKUP_PASSPHRASE"
  elif [ -n "${BACKUP_PASSPHRASE_FILE:-}" ] && [ -r "$BACKUP_PASSPHRASE_FILE" ]; then
    PASS="$(cat "$BACKUP_PASSPHRASE_FILE")"
  else
    log "!! ENCRYPT=1 but no BACKUP_PASSPHRASE (env) or BACKUP_PASSPHRASE_FILE"
    exit 2
  fi
fi
encrypt_file() {
  local in="$1" out="$1.enc"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$in" -out "$out" -pass env:_PLUTO_PASS
  rm -f "$in"
  echo "$out"
}
export _PLUTO_PASS="$PASS"

# ─── 1. slim source zip ───────────────────────────────────────────
ZIP="$BACKUP_DIR/zip/pluto-complete-$STAMP.zip"
log "==> zipping source (excluding node_modules, dist, .next, caches, logs)"
( cd "$(dirname "$PROJECT_DIR")" && \
  zip -qr "$ZIP" "$(basename "$PROJECT_DIR")" \
    -x "*/node_modules/*" "*/.git/*" "*/dist/*" "*/.next/*" \
       "*/.cache/*" "*/.turbo/*" "*/.vite/*" "*/coverage/*" \
       "*/logs/*" "*/*.log" "*/tmp/*" "*/.DS_Store" \
) || fail "zip failed"

# ─── 2. postgres dump ─────────────────────────────────────────────
DUMP="$BACKUP_DIR/db/pluto-db-$STAMP.dump"
log "==> pg_dump ($PG_CONTAINER → $DUMP)"
docker exec -i "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" \
  -F c -Z 9 --no-owner --no-privileges > "$DUMP" || fail "pg_dump failed"

# ─── 3. server configs ────────────────────────────────────────────
CFG="$BACKUP_DIR/config/pluto-config-$STAMP.tar.gz"
log "==> tar server configs"
tar czf "$CFG" \
  /etc/nginx/sites-available /etc/nginx/sites-enabled \
  /etc/systemd/system/pluto-*.service /etc/systemd/system/pluto-*.timer \
  /etc/letsencrypt/live /etc/letsencrypt/renewal \
  "$PROJECT_DIR/pluto-backend/.env" 2>/dev/null || fail "config tar failed"

# ─── 4. restore-verify ────────────────────────────────────────────
log "==> restore-verify (pg_restore --list)"
if pg_restore --list "$DUMP" > "$LOG_DIR/restore-list-$STAMP.txt" 2>&1; then
  ENTRIES=$(wc -l < "$LOG_DIR/restore-list-$STAMP.txt")
  log "   ✔ archive readable — $ENTRIES TOC entries"
else
  fail "pg_restore --list rejected the dump"
fi

# ─── 5. optional encrypt ──────────────────────────────────────────
if [ "$ENCRYPT" = "1" ]; then
  log "==> encrypting artifacts (AES-256-CBC, pbkdf2)"
  [ -f "$ZIP" ]  && ZIP=$(encrypt_file "$ZIP")
  [ -f "$DUMP" ] && DUMP=$(encrypt_file "$DUMP")
  [ -f "$CFG" ]  && CFG=$(encrypt_file "$CFG")
fi
unset _PLUTO_PASS

# ─── 6. checksums + manifest ──────────────────────────────────────
log "==> checksums"
for f in "$ZIP" "$DUMP" "$CFG"; do
  [ -f "$f" ] && sha256sum "$f" > "$f.sha256"
done

MAN="$BACKUP_DIR/manifest/manifest-$STAMP.json"
sha() { [ -f "$1" ] && sha256sum "$1" | awk '{print $1}' || echo ""; }
size() { [ -f "$1" ] && stat -c%s "$1" 2>/dev/null || echo 0; }
cat > "$MAN" <<EOF
{
  "stamp": "$STAMP",
  "status": "$STATUS",
  "encrypted": $( [ "$ENCRYPT" = "1" ] && echo true || echo false ),
  "host": "$(hostname -f 2>/dev/null || hostname)",
  "artifacts": {
    "zip":    { "path": "$ZIP",  "size": $(size "$ZIP"),  "sha256": "$(sha "$ZIP")"  },
    "db":     { "path": "$DUMP", "size": $(size "$DUMP"), "sha256": "$(sha "$DUMP")" },
    "config": { "path": "$CFG",  "size": $(size "$CFG"),  "sha256": "$(sha "$CFG")"  }
  },
  "restore_verify": {
    "tool": "pg_restore --list",
    "entries": ${ENTRIES:-0},
    "log": "$LOG_DIR/restore-list-$STAMP.txt"
  },
  "log": "$LOG"
}
EOF
log "==> manifest → $MAN"

# ─── 7. prune ─────────────────────────────────────────────────────
prune() {
  local dir="$1" pattern="$2"
  ls -1t "$dir"/$pattern 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do
    log "   prune $old"; rm -f "$old" "$old.sha256"
  done
}
prune "$BACKUP_DIR/zip"      "pluto-complete-*"
prune "$BACKUP_DIR/db"       "pluto-db-*"
prune "$BACKUP_DIR/config"   "pluto-config-*"
prune "$BACKUP_DIR/manifest" "manifest-*.json"

log "==> STATUS=$STATUS  (keep=$KEEP  encrypt=$ENCRYPT)"
[ "$STATUS" = "ok" ] || exit 1
