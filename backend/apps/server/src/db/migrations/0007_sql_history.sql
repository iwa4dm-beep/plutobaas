-- Phase 8: SQL runner history for the admin dashboard.
--
-- Every query executed through /admin/v1/sql lands here so operators
-- can audit who ran what, re-run past queries, and share links with
-- teammates. Read-only executions are marked as such and cannot be
-- edited to look like a write after the fact.

create table if not exists public.sql_history (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references public.workspaces(id) on delete set null,
  user_id       uuid references public.users(id)      on delete set null,
  user_email    text,
  sql           text not null,
  read_only     boolean not null default false,
  status        text not null check (status in ('ok','error')),
  row_count     integer,
  duration_ms   integer not null default 0,
  error         text,
  ran_at        timestamptz not null default now()
);

create index if not exists sql_history_ws_idx     on public.sql_history (workspace_id, ran_at desc);
create index if not exists sql_history_user_idx   on public.sql_history (user_id, ran_at desc);
create index if not exists sql_history_ran_at_idx on public.sql_history (ran_at desc);

grant select on public.sql_history to authenticated;
grant all    on public.sql_history to service_role;

alter table public.sql_history enable row level security;

-- Members can read history for workspaces they belong to; admins see everything.
drop policy if exists sql_history_read on public.sql_history;
create policy sql_history_read on public.sql_history
  for select to authenticated
  using (public.is_admin() or public.is_workspace_member(workspace_id));

-- Nobody writes directly — the server does inserts via service_role.
drop policy if exists sql_history_no_write on public.sql_history;
create policy sql_history_no_write on public.sql_history
  for all to authenticated using (false) with check (false);

-- +migrate down
drop table if exists public.sql_history;
