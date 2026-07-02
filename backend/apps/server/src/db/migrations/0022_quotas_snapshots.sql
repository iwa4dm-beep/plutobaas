-- Phase 22 — Quota overage behavior, environment-tagged usage, PITR snapshots.
--
-- 1) Add per-quota overage behavior + billing label; also environment tag on
--    usage events so we can distinguish production/preview/dev consumption
--    per workspace.
-- 2) Snapshot table backs the branching PITR-lite flow: each snapshot is a
--    copied Postgres schema (`snap_<id>`) frozen at a moment in time, with
--    a manifest for later restore/diff.

alter table public.workspace_quotas
  add column if not exists overage_behavior text not null default 'warn'
    check (overage_behavior in ('allow','warn','block')),
  add column if not exists billing_label text;

alter table public.usage_events
  add column if not exists environment text not null default 'production'
    check (environment in ('production','preview','development')),
  add column if not exists billing_label text;

create index if not exists idx_usage_ws_env_time
  on public.usage_events (workspace_id, environment, observed_at desc);

create table if not exists public.db_branch_snapshots (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references public.db_branches(id) on delete cascade,
  workspace_id    uuid not null,
  snapshot_schema text not null unique,
  reason          text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  restored_at     timestamptz,
  status          text not null default 'ready' check (status in ('ready','restored','archived'))
);
create index if not exists idx_branch_snapshots_branch
  on public.db_branch_snapshots (branch_id, created_at desc);

grant select on public.db_branch_snapshots to authenticated;
grant all    on public.db_branch_snapshots to service_role;
alter table public.db_branch_snapshots enable row level security;
create policy branch_snapshots_ws on public.db_branch_snapshots
  for select to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true));
