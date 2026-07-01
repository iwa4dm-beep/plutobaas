#!/usr/bin/env bash
# Restore a Pluto DB dump AND verify integrity.
# Usage:  ./scripts/restore.sh <path-to-pluto-db-*.sql.gz>
#
# Steps:
#   1. Verify gzip + sha256 sidecar (if present).
#   2. Prompt for confirmation.
#   3. Restore into $POSTGRES_DB.
#   4. Restart the API and wait for /readyz.
#   5. Run post-restore integrity probes (row counts, migration ledger).
set -euo pipefail

DUMP="${1:?path to .sql.gz dump required}"
[[ -f "$DUMP" ]] || { echo "not found: $DUMP"; exit 1; }

cd "$(dirname "$0")/.."
set -a; source .env; set +a

echo "==> verify archive"
gzip -t "$DUMP" || { echo "!! corrupt gzip"; exit 1; }
if [[ -f "$DUMP.sha256" ]]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256") \
    || { echo "!! sha256 mismatch"; exit 1; }
else
  echo "   (no .sha256 sidecar — skipping checksum verify)"
fi

echo
echo "!! This will OVERWRITE database '$POSTGRES_DB' on the running stack."
read -rp "Type the DB name to confirm: " confirm
[[ "$confirm" == "$POSTGRES_DB" ]] || { echo "aborted"; exit 1; }

echo "==> restore"
gunzip -c "$DUMP" | docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 >/dev/null

echo "==> restart api"
docker compose -f docker-compose.prod.yml restart pluto >/dev/null
./scripts/wait-for-healthy.sh "https://${DOMAIN}" 120

echo "==> integrity checks"
q() {
  docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"
}
users=$(q "select count(*) from public.users" || echo "?")
roles=$(q "select count(*) from public.user_roles" 2>/dev/null || echo "0")
migs=$(q "select count(*) from public._pluto_migrations" 2>/dev/null || \
        q "select count(*) from public.schema_migrations" 2>/dev/null || echo "?")
latest=$(q "select max(applied_at)::text from public._pluto_migrations" 2>/dev/null || echo "?")

printf "   users:       %s\n" "$users"
printf "   user_roles:  %s\n" "$roles"
printf "   migrations:  %s  (latest applied %s)\n" "$migs" "$latest"

if [[ "$users" == "?" || "$migs" == "?" ]]; then
  echo "!! one or more integrity probes failed — inspect the DB manually" >&2
  exit 2
fi

echo "==> restore verified."
