#!/usr/bin/env bash
# Automated Postgres + storage backup with daily / weekly retention.
# Cron examples:
#   5 3 * * *   /opt/pluto/backend/scripts/backup.sh daily   >> /var/log/pluto-backup.log 2>&1
#   30 3 * * 0  /opt/pluto/backend/scripts/backup.sh weekly  >> /var/log/pluto-backup.log 2>&1
#
# Env (from .env):
#   BACKUP_DIR                  root dir for backups (default /var/backups/pluto)
#   BACKUP_RETENTION_DAILY      keep N daily dumps  (default 14)
#   BACKUP_RETENTION_WEEKLY     keep N weekly dumps (default 12)
set -euo pipefail

BUCKET="${1:-daily}"
case "$BUCKET" in daily|weekly|manual) ;; *) echo "usage: $0 [daily|weekly|manual]"; exit 2;; esac

cd "$(dirname "$0")/.."
set -a; source .env; set +a

ROOT="${BACKUP_DIR:-/var/backups/pluto}"
DEST="$ROOT/$BUCKET"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$DEST/pluto-db-$STAMP.sql.gz"
KEEP_DAILY="${BACKUP_RETENTION_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_RETENTION_WEEKLY:-12}"

mkdir -p "$DEST"

echo "==> [$BUCKET] pg_dump → $DUMP"
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists \
  | gzip -9 > "$DUMP"

# Verify the archive is well-formed before we count it as a success.
if ! gzip -t "$DUMP" 2>/dev/null; then
  echo "!! corrupt gzip, removing $DUMP" >&2
  rm -f "$DUMP"; exit 1
fi
BYTES=$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")
if [ "$BYTES" -lt 1024 ]; then
  echo "!! dump suspiciously small ($BYTES bytes), removing" >&2
  rm -f "$DUMP"; exit 1
fi
sha256sum "$DUMP" > "$DUMP.sha256" 2>/dev/null || shasum -a 256 "$DUMP" > "$DUMP.sha256"

# Mirror MinIO/S3 bucket into the same time-stamped folder.
if [ "${STORAGE_DRIVER:-}" = "s3" ]; then
  echo "==> mirror storage bucket → $DEST/storage-$STAMP"
  docker compose -f docker-compose.prod.yml run --rm -T \
    -v "$DEST:/backup" minio/mc:latest sh -c "
      mc alias set src ${S3_ENDPOINT} ${S3_ACCESS_KEY} ${S3_SECRET_KEY} >/dev/null &&
      mc mirror --overwrite --quiet src/${S3_BUCKET} /backup/storage-$STAMP
    " || echo "   (mc mirror failed — skipping)"
fi

# Prune by bucket-specific retention.
case "$BUCKET" in
  daily)  KEEP=$KEEP_DAILY ;;
  weekly) KEEP=$KEEP_WEEKLY ;;
  *)      KEEP=9999 ;;
esac
echo "==> prune $BUCKET, keep newest $KEEP"
ls -1t "$DEST"/pluto-db-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  echo "   rm $old"; rm -f "$old" "$old.sha256"
done

echo "==> done. $BUCKET dumps: $(ls -1 "$DEST"/pluto-db-*.sql.gz 2>/dev/null | wc -l)"
