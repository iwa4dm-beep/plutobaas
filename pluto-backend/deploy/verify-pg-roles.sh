#!/usr/bin/env bash
# Pre-deploy Postgres role verifier.
#
# Checks that anon / authenticated / service_role / admin exist in the
# Pluto Postgres container. If any is missing, applies ensure-pg-roles.sql
# to create them, then re-verifies. Idempotent + safe to run every deploy.
#
# Usage:
#   bash deploy/verify-pg-roles.sh
#
# Env (inherits from .env alongside docker-compose.yml):
#   POSTGRES_USER, POSTGRES_DB
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE=(docker compose --env-file .env -f docker/docker-compose.yml)

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

PG_USER="${POSTGRES_USER:-pluto}"
PG_DB="${POSTGRES_DB:-pluto}"

REQUIRED=(anon authenticated service_role admin)

echo "→ verifying Postgres roles in container 'postgres' (user=$PG_USER db=$PG_DB)"

present=$("${COMPOSE[@]}" exec -T postgres \
  psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','admin') ORDER BY rolname;" \
  | tr -d '\r' | sort -u | tr '\n' ' ')

echo "  present: ${present:-<none>}"

missing=()
for r in "${REQUIRED[@]}"; do
  case " $present " in
    *" $r "*) ;;
    *) missing+=("$r") ;;
  esac
done

if [ "${#missing[@]}" -eq 0 ]; then
  echo "✓ all required roles present (anon/authenticated/service_role/admin)"
  exit 0
fi

echo "⚠ missing roles: ${missing[*]} — applying deploy/ensure-pg-roles.sql"
"${COMPOSE[@]}" exec -T postgres psql -U "$PG_USER" -d "$PG_DB" < deploy/ensure-pg-roles.sql

# Re-verify.
present=$("${COMPOSE[@]}" exec -T postgres \
  psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','admin') ORDER BY rolname;" \
  | tr -d '\r' | sort -u | tr '\n' ' ')

echo "  after-fix present: ${present:-<none>}"

still_missing=()
for r in "${REQUIRED[@]}"; do
  case " $present " in
    *" $r "*) ;;
    *) still_missing+=("$r") ;;
  esac
done

if [ "${#still_missing[@]}" -ne 0 ]; then
  echo "✗ role verification FAILED — still missing: ${still_missing[*]}" >&2
  exit 1
fi

echo "✓ roles created and verified"
