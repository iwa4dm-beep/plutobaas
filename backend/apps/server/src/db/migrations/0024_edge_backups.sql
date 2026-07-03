-- Phase 24 — Edge Functions v2 (secrets, cron schedules, invocation logs)
--             and workspace Backup / Export jobs.

create table if not exists public.fn_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  function_slug text not null,
  name text not null,
  value_cipher text not null,        -- opaque cipher-text (encrypted at rest by app)
  created_at timestamptz not null default now(),
  unique (workspace_id, function_slug, name)
);

create table if not exists public.fn_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  function_slug text not null,
  cron text not null,                -- e.g. "*/5 * * * *"
  active boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.fn_invocations (
  id bigserial primary key,
  workspace_id uuid,
  function_slug text not null,
  trigger text not null default 'http', -- http|cron|manual
  status_code int,
  duration_ms int,
  cold_start boolean default false,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists fn_invocations_slug_time_idx on public.fn_invocations(function_slug, created_at desc);

create table if not exists public.backup_exports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  kind text not null default 'full', -- full | schema | table
  target text,                        -- schema/table name (optional)
  status text not null default 'pending', -- pending|running|done|failed
  bytes bigint default 0,
  download_path text,                 -- storage path or /tmp path
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

grant select, insert, update, delete on public.fn_secrets     to authenticated;
grant select, insert, update, delete on public.fn_schedules   to authenticated;
grant select, insert, update, delete on public.fn_invocations to authenticated;
grant select, insert, update, delete on public.backup_exports to authenticated;
grant usage, select on sequence public.fn_invocations_id_seq  to authenticated;
grant all on public.fn_secrets, public.fn_schedules, public.fn_invocations,
             public.backup_exports to service_role;

alter table public.fn_secrets     enable row level security;
alter table public.fn_schedules   enable row level security;
alter table public.fn_invocations enable row level security;
alter table public.backup_exports enable row level security;

create policy if not exists fn_secrets_ws     on public.fn_secrets     for all to authenticated using (true) with check (true);
create policy if not exists fn_schedules_ws   on public.fn_schedules   for all to authenticated using (true) with check (true);
create policy if not exists fn_invocations_ws on public.fn_invocations for all to authenticated using (true) with check (true);
create policy if not exists backup_exports_ws on public.backup_exports for all to authenticated using (true) with check (true);
