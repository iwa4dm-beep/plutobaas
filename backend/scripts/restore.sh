#!/usr/bin/env bash
# Restore a Postgres dump produced by backup.sh.
# Usage:  ./scripts/restore.sh /var/backups/pluto/pluto-db-20260701T030000Z.sql.gz
set -euo pipefail

DUMP="${1:?path to .sql.gz dump required}"
[[ -f "$DUMP" ]] || { echo "not found: $DUMP"; exit 1; }

cd "$(dirname "$0")/.."
set -a; source .env; set +a

echo "!! This will OVERWRITE database '$POSTGRES_DB' on the running stack."
read -rp "Type the DB name to confirm: " confirm
[[ "$confirm" == "$POSTGRES_DB" ]] || { echo "aborted"; exit 1; }

gunzip -c "$DUMP" | docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1

echo "==> restart api to reload schema cache"
docker compose -f docker-compose.prod.yml restart pluto
./scripts/wait-for-healthy.sh "https://${DOMAIN}" 120
echo "restore complete."
