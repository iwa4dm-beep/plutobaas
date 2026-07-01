#!/usr/bin/env bash
# Dump Postgres + sync MinIO bucket to $BACKUP_DIR, prune old files.
# Cron:  0 3 * * *  /opt/pluto/backend/scripts/backup.sh >> /var/log/pluto-backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

BACKUP_DIR="${BACKUP_DIR:-/var/backups/pluto}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

echo "==> pg_dump"
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists \
  | gzip -9 > "$BACKUP_DIR/pluto-db-$STAMP.sql.gz"

if [[ "${STORAGE_DRIVER:-}" == "s3" ]]; then
  echo "==> minio mirror"
  docker compose -f docker-compose.prod.yml run --rm -T mc \
    mirror --overwrite "local/${S3_BUCKET}" "/backup/storage-$STAMP" || true
fi

echo "==> prune older than ${RETENTION}d"
find "$BACKUP_DIR" -name 'pluto-db-*.sql.gz' -mtime "+${RETENTION}" -delete

echo "==> done: $(ls -lh "$BACKUP_DIR" | tail -n +2 | wc -l) files in $BACKUP_DIR"
