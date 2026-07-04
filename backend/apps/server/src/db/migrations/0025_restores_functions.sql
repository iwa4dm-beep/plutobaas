-- Phase 25 — Backup restore jobs + Edge Functions v2 catalog + alert thresholds.

create table if not exists public.backup_restores (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  export_id uuid not null references public.backup_exports(id) on delete cascade,
  dry_run boolean not null default true,
  status text not null default 'pending', -- pending|running|done|failed|canceled
  progress int  not null default 0,       -- 0..100
  applied_statements int not null default 0,
  total_statements int not null default 0,
  log text not null default '',
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

grant select, insert, update, delete on public.backup_restores to authenticated;
grant all on public.backup_restores to service_role;
alter table public.backup_restores enable row level security;
create policy if not exists backup_restores_ws on public.backup_restores
  for all to authenticated using (true) with check (true);

create table if not exists public.fn_functions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  slug text not null,
  display_name text,
  runtime text not null default 'node20',
  entry text not null default 'index.ts',
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, slug)
);
grant select, insert, update, delete on public.fn_functions to authenticated;
grant all on public.fn_functions to service_role;
alter table public.fn_functions enable row level security;
create policy if not exists fn_functions_ws on public.fn_functions
  for all to authenticated using (true) with check (true);

-- Alert thresholds on quotas (percentage of hard_limit that triggers warn).
alter table public.workspace_quotas
  add column if not exists alert_pct int;
