-- Phase 21 — Database branching (MVP), Studio schema history, and metered usage.
--
-- Branching MVP: each branch is a named Postgres schema. Parent/child links
-- and a per-branch statement log let us evolve schemas independently and lay
-- groundwork for future PITR / diff / merge tooling.

create table if not exists public.db_branches (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  name         text not null,
  schema_name  text not null unique,
  parent_id    uuid references public.db_branches(id) on delete set null,
  status       text not null default 'active' check (status in ('active','archived')),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);
grant select, insert, update, delete on public.db_branches to authenticated;
grant all on public.db_branches to service_role;
alter table public.db_branches enable row level security;
create policy branches_ws on public.db_branches
  for all to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true))
  with check (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.db_branch_changes (
  id         bigserial primary key,
  branch_id  uuid not null references public.db_branches(id) on delete cascade,
  statement  text not null,
  applied_by uuid,
  applied_at timestamptz not null default now(),
  ok         boolean not null default true,
  error      text
);
create index if not exists idx_branch_changes_branch on public.db_branch_changes (branch_id, applied_at desc);
grant select on public.db_branch_changes to authenticated;
grant all on public.db_branch_changes to service_role;
alter table public.db_branch_changes enable row level security;
create policy branch_changes_ws on public.db_branch_changes
  for select to authenticated
  using (branch_id in (select id from public.db_branches
                       where workspace_id::text = current_setting('request.workspace_id', true)));

-- Studio schema edits — audit of structured operations applied through the editor.
create table if not exists public.schema_edits (
  id           bigserial primary key,
  workspace_id uuid,
  branch_id    uuid references public.db_branches(id) on delete set null,
  operation    jsonb not null,            -- {op, table, column, ...}
  sql          text  not null,
  applied_by   uuid,
  applied_at   timestamptz not null default now(),
  ok           boolean not null default true,
  error        text
);
create index if not exists idx_schema_edits_ws on public.schema_edits (workspace_id, applied_at desc);
grant select on public.schema_edits to authenticated;
grant all on public.schema_edits to service_role;
alter table public.schema_edits enable row level security;
create policy schema_edits_ws on public.schema_edits
  for select to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true));

-- Metered usage — one row per event, aggregated on read.
create table if not exists public.usage_events (
  id           bigserial primary key,
  workspace_id uuid not null,
  metric       text not null check (metric in
                 ('storage_gb','egress_gb','function_invocations','ai_tokens','db_rows','realtime_msgs')),
  quantity     double precision not null,
  meta         jsonb not null default '{}'::jsonb,
  observed_at  timestamptz not null default now()
);
create index if not exists idx_usage_ws_metric_time
  on public.usage_events (workspace_id, metric, observed_at desc);
grant select on public.usage_events to authenticated;
grant all    on public.usage_events to service_role;
grant insert on public.usage_events to pluto_jobs;
alter table public.usage_events enable row level security;
create policy usage_ws_read on public.usage_events
  for select to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.workspace_quotas (
  workspace_id uuid not null,
  metric       text not null,
  period       text not null default 'month' check (period in ('day','month')),
  hard_limit   double precision not null,
  soft_limit   double precision,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, metric, period)
);
grant select, insert, update on public.workspace_quotas to authenticated;
grant all on public.workspace_quotas to service_role;
alter table public.workspace_quotas enable row level security;
create policy quotas_ws on public.workspace_quotas
  for all to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true))
  with check (workspace_id::text = current_setting('request.workspace_id', true));
