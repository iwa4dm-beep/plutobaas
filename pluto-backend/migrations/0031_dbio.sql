-- Phase 16 · 0031 — Database Import / Export & External Connections
-- Superadmin surface behind /admin/v1/dbio/* for:
--   • saving encrypted credentials to external MySQL/Postgres/SQLite DBs
--   • uploading .sql dump / schema files and applying them
--   • CSV import
--   • tracking long-running import jobs
--
-- Encrypted credentials use pgcrypto's pgp_sym_encrypt. The passphrase is the
-- DBIO_ENC_KEY env var; the API reads it at boot and passes it as a bind
-- parameter — it is NEVER stored in the DB.

create extension if not exists pgcrypto;

create schema if not exists admin;

-- ─────────────────────────────── connections ────────────────────────────────
create table if not exists admin.db_connections (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  dialect       text not null check (dialect in ('postgres','mysql','mariadb','sqlite')),
  host          text,
  port          integer,
  database_name text,
  username      text,
  password_enc  bytea,          -- pgp_sym_encrypt(password, $enc_key)
  ssl           boolean not null default false,
  options_json  jsonb not null default '{}'::jsonb,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  last_tested_at timestamptz,
  last_test_ok   boolean,
  last_test_error text,
  unique (name)
);

grant select, insert, update, delete on admin.db_connections to authenticated;
grant all on admin.db_connections to service_role;
alter table admin.db_connections enable row level security;

-- Superadmin-only: routes enforce this in code, RLS is a defense-in-depth net.
drop policy if exists dbconn_superadmin_all on admin.db_connections;
create policy dbconn_superadmin_all on admin.db_connections
  for all to authenticated
  using (exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin))
  with check (exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin));

-- ─────────────────────────────── import jobs ────────────────────────────────
create table if not exists admin.import_jobs (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('schema','dump','csv','mysql_live')),
  source_dialect text not null check (source_dialect in ('postgres','mysql','mariadb','sqlite','csv')),
  target_schema  text not null default 'public',
  file_name      text,
  file_bytes     bigint,
  status         text not null default 'pending' check (status in ('pending','running','success','failed','cancelled')),
  stmt_total     integer not null default 0,
  stmt_applied   integer not null default 0,
  stmt_failed    integer not null default 0,
  rows_inserted  bigint not null default 0,
  log            text not null default '',
  error_message  text,
  created_by     uuid,
  connection_id  uuid references admin.db_connections(id) on delete set null,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

grant select, insert, update, delete on admin.import_jobs to authenticated;
grant all on admin.import_jobs to service_role;
alter table admin.import_jobs enable row level security;

drop policy if exists dbio_jobs_superadmin_all on admin.import_jobs;
create policy dbio_jobs_superadmin_all on admin.import_jobs
  for all to authenticated
  using (exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin))
  with check (exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin));

create index if not exists dbio_jobs_created_at_idx on admin.import_jobs (created_at desc);
create index if not exists dbio_jobs_status_idx     on admin.import_jobs (status);
