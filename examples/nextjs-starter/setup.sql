-- ─────────────────────────────────────────────────────────────
-- Pluto BaaS — Next.js starter schema entrypoint
-- Applies every file under ./migrations/ in sorted order and
-- records applied versions in public._starter_migrations so
-- local and cloud provisioning stay in sync.
--
-- Usage (manual):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f setup.sql
-- ─────────────────────────────────────────────────────────────

create table if not exists public._starter_migrations (
  version    int primary key,
  name       text not null,
  applied_at timestamptz not null default now()
);

grant select on public._starter_migrations to authenticated;
grant all    on public._starter_migrations to service_role;

\ir migrations/0001_notes.sql
insert into public._starter_migrations (version, name) values (1, '0001_notes')
  on conflict (version) do nothing;

\ir migrations/0002_seed_sample_notes.sql
insert into public._starter_migrations (version, name) values (2, '0002_seed_sample_notes')
  on conflict (version) do nothing;

\ir migrations/0003_schema_version.sql
insert into public._starter_migrations (version, name) values (3, '0003_schema_version')
  on conflict (version) do nothing;
