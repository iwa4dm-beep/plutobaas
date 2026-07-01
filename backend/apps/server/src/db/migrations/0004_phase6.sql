-- Phase 6: migration ledger, dedicated pool user, job tokens.

-- Migration ledger — every applied file is recorded with hash + duration
-- so the dashboard can show version history and detect drift.
create table if not exists public.schema_migrations (
  version      text primary key,          -- e.g. "0004_phase6"
  name         text not null,
  checksum     text not null,             -- sha256 of file body
  applied_at   timestamptz not null default now(),
  applied_by   text not null default 'runner',
  duration_ms  int not null default 0,
  status       text not null default 'applied'
                 check (status in ('applied','rolled_back','failed')),
  down_sql     text,                      -- optional inverse
  error        text
);

grant select on public.schema_migrations to authenticated;
grant all    on public.schema_migrations to service_role;

-- Dedicated non-superuser role used by server-side jobs. It BYPASSRLS
-- so background tasks can read/write across users, but we NEVER hand
-- this role's credentials to clients. Clients get short-lived job
-- tokens (see below) that the server exchanges for a pooled connection
-- running as pluto_jobs.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pluto_jobs') then
    create role pluto_jobs login password 'pluto_jobs_change_me' bypassrls;
  end if;
end$$;

grant usage on schema public to pluto_jobs;
grant select, insert, update, delete on all tables    in schema public to pluto_jobs;
grant usage, select                  on all sequences in schema public to pluto_jobs;
alter default privileges in schema public
  grant select, insert, update, delete on tables    to pluto_jobs;
alter default privileges in schema public
  grant usage, select                  on sequences to pluto_jobs;

-- Job tokens: opaque bearer tokens minted by admins and consumed by
-- server-side workers. They carry a scope (allowed job names) and a
-- hard expiry. The token hash is stored, never the plaintext.
create table if not exists public.job_tokens (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  token_hash   text not null unique,
  scope        text[] not null default '{}',
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  use_count    bigint not null default 0
);

grant select on public.job_tokens to authenticated;
grant all    on public.job_tokens to service_role;

alter table public.job_tokens enable row level security;

-- Only the service role touches this table directly; RLS locks out
-- everyone else so a leaked anon key cannot enumerate tokens.
drop policy if exists job_tokens_service_only on public.job_tokens;
create policy job_tokens_service_only on public.job_tokens
  for all to authenticated using (false) with check (false);
