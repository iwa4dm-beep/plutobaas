#!/usr/bin/env bash
# fix-owner-id-and-rebuild-sandbox.sh — emergency VPS repair for:
#   1) migration apply_failed: column "owner_id" does not exist
#   2) broken/stale sandbox worker on 127.0.0.1:8787
#
# Run from ~/backend-joy/pluto-backend after git pull.

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "✗ run as root (sudo)"; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker/docker-compose.yml}"
SLUG="${SLUG:-${1:-}}"
WILDCARD="${WILDCARD:-app.timescard.cloud}"
ACME_EMAIL="${ACME_EMAIL:-admin@${WILDCARD#*.}}"

log(){ printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
placeholder(){ case "${1:-}" in ""|*"<"*">"*) return 0;; *) return 1;; esac; }

[ -f "$ENV_FILE" ] || die ".env not found at $ENV_FILE"
[ -n "$SLUG" ] || die "SLUG required: sudo SLUG='dbhstock-8myjt4' ..."
placeholder "${SECRET:-}" && die "SECRET required and must be the real sandbox shared secret, not <placeholder>"
placeholder "${SERVICE_KEY:-}" && die "SERVICE_KEY required and must be the real service key, not <placeholder>"
placeholder "${UPSTREAM:-}" && die "UPSTREAM required, e.g. https://your-project-ref.supabase.co"

cd "$ROOT"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${POSTGRES_USER:=pluto}"
: "${POSTGRES_DB:=pluto}"

log "1/6 preflight env + compose services"
bash "$HERE/check-env.sh"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres redis minio

log "2/6 direct schema self-heal for owner_id drift"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists admin;

create table if not exists admin.workspaces (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name         text not null,
  owner_id     uuid references auth.users(id) on delete set null,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists admin.workspace_members (
  workspace_id uuid not null references admin.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner','admin','developer','viewer')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table if exists admin.projects
  add column if not exists owner_id uuid references auth.users(id) on delete set null,
  add column if not exists workspace_id uuid references admin.workspaces(id) on delete set null,
  add column if not exists created_at timestamptz default now();

alter table if exists admin.workspaces
  add column if not exists owner_id uuid references auth.users(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists workspaces_owner_idx on admin.workspaces(owner_id);
create index if not exists projects_owner_idx on admin.projects(owner_id);
SQL

log "3/6 rebuild/restart API so migration apply endpoint has the fix"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build api
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d api

log "4/6 apply pending backend migrations"
bash "$HERE/run-migrator.sh"

log "5/6 nuke and rebuild sandbox worker on port 8787"
KEEP_SITES="${KEEP_SITES:-1}" TAKEOVER_PORT="${TAKEOVER_PORT:-1}" \
  SECRET="$SECRET" SERVICE_KEY="$SERVICE_KEY" UPSTREAM="$UPSTREAM" \
  WILDCARD="$WILDCARD" ACME_EMAIL="$ACME_EMAIL" SLUG="$SLUG" \
  bash "$HERE/nuke-and-rebuild-sandbox.sh"

log "6/6 verify served site"
bash "$HERE/verify-deploy.sh" "$SLUG" || {
  echo
  echo "⚠ sandbox/API are repaired, but no bundle is live for '$SLUG' yet."
  echo "  Run Auto Deploy for this project once, then rerun: bash deploy/verify-deploy.sh $SLUG"
  exit 1
}

printf '\n\033[1;32m✓ owner_id migration drift fixed and sandbox rebuilt\033[0m\n'