#!/usr/bin/env bash
# Containerized migration runner — applies pending SQL files using the same
# image (and therefore the same DATABASE_URL / env) as the api service.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker/docker-compose.yml}"
OVERLAY_FILE="$ROOT/docker/docker-compose.migrator.yml"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

bash "$HERE/check-env.sh"

echo "▶ building api image (for migrator overlay)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" build migrator

echo "▶ dry-running pending migrations (rolled-back transaction)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" \
  run --rm --no-deps migrator --dry-run

echo "▶ running migrator (one-shot apply)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERLAY_FILE" \
  run --rm --no-deps migrator

echo "✔ migrator finished — verifying ledger"
bash "$HERE/verify-migrations.sh"
