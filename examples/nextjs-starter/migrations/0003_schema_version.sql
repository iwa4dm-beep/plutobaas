-- ─────────────────────────────────────────────────────────────
-- Records the canonical starter schema version so Playwright's
-- global-setup can assert local ⇔ cloud parity before the suite
-- runs. Bump STARTER_SCHEMA_VERSION whenever a migration is added.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.starter_schema_version (
  version     int primary key,
  applied_at  timestamptz not null default now()
);

grant select on public.starter_schema_version to anon, authenticated;
grant all    on public.starter_schema_version to service_role;

alter table public.starter_schema_version enable row level security;

drop policy if exists "schema_version readable" on public.starter_schema_version;
create policy "schema_version readable"
  on public.starter_schema_version for select
  to anon, authenticated
  using (true);

insert into public.starter_schema_version (version) values (3)
  on conflict (version) do nothing;
