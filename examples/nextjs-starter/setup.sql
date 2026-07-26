-- ─────────────────────────────────────────────────────────────
-- Pluto BaaS — Next.js starter schema entrypoint
-- Applies every file under ./migrations/ in sorted order and
-- records applied versions in public._starter_migrations so
-- local and cloud provisioning stay in sync.
--
-- Usage (manual):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f setup.sql
--
-- The docker-compose starter-schema service invokes each migration
-- individually via psql -f so it works without a server-side
-- filesystem walker.
-- ─────────────────────────────────────────────────────────────

create table if not exists public._starter_migrations (
  version    int primary key,
  name       text not null,
  applied_at timestamptz not null default now()
);

grant select on public._starter_migrations to authenticated;
grant all    on public._starter_migrations to service_role;

-- Register versions applied by the sibling migrations/*.sql files.
-- Migration files themselves are idempotent; this table only records that
-- setup.sql has seen them at least once.
\ir migrations/0001_notes.sql
insert into public._starter_migrations (version, name) values (1, '0001_notes')
  on conflict (version) do nothing;

-- Optional seed (opt in): set STARTER_SEED=1 in env; docker-compose reads it.
-- Manual apply always runs the seed; it is a no-op when the users don't exist.
\ir migrations/0002_seed_sample_notes.sql
insert into public._starter_migrations (version, name) values (2, '0002_seed_sample_notes')
  on conflict (version) do nothing;
