#!/usr/bin/env bash
# One-command migration verifier.
# Diffs migrations/*.sql (on disk) against public._pluto_migrations (in DB)
# and reports which files are missing / applied / orphaned.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MIG_DIR="$ROOT/migrations"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
PG_SERVICE="${PG_SERVICE:-postgres}"

if [ ! -f "$ENV_FILE" ]; then echo "✘ .env not found at $ENV_FILE"; exit 1; fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

: "${POSTGRES_USER:=pluto}"
: "${POSTGRES_DB:=pluto}"

echo "▶ verifying migrations against $POSTGRES_DB (service: $PG_SERVICE)"

APPLIED_TSV="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F $'\t' \
  -c "select name, applied_at from public._pluto_migrations order by name" 2>/dev/null || true)"

declare -A APPLIED
while IFS=$'\t' read -r name applied_at; do
  [ -z "$name" ] && continue
  APPLIED["$name"]="$applied_at"
done <<< "$APPLIED_TSV"

missing=0; ok=0
echo
printf "  %-52s %s\n" "MIGRATION" "STATUS"
printf "  %-52s %s\n" "----------------------------------------------------" "----------------------------"
for f in "$MIG_DIR"/*.sql; do
  base="$(basename "$f")"
  if [ -n "${APPLIED[$base]+x}" ]; then
    printf "  %-52s ✔ applied %s\n" "$base" "${APPLIED[$base]}"
    ok=$((ok+1))
    unset "APPLIED[$base]"
  else
    printf "  %-52s ✘ MISSING\n" "$base"
    missing=$((missing+1))
  fi
done

orphan=0
for name in "${!APPLIED[@]}"; do
  printf "  %-52s ⚠ orphan in ledger (%s)\n" "$name" "${APPLIED[$name]}"
  orphan=$((orphan+1))
done

echo
echo "  summary: $ok applied, $missing missing, $orphan orphan"
if [ "$missing" -gt 0 ]; then
  echo "  → run: bash $HERE/run-migrator.sh"
  exit 2
fi
echo "✔ migration ledger is up to date"
