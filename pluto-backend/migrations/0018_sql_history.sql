-- Phase 15 · 0018 — SQL editor history + saved snippets
-- Powers /admin/v1/sql/history + the SQL editor page.

create table if not exists admin.sql_history (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  user_id       uuid references auth.users(id)      on delete set null,
  statement     text not null,
  row_count     integer,
  duration_ms   integer,
  error         text,
  executed_at   timestamptz not null default now()
);
create index if not exists sql_history_ws_ts_idx on admin.sql_history(workspace_id, executed_at desc);
create index if not exists sql_history_user_idx  on admin.sql_history(user_id, executed_at desc);

create table if not exists admin.sql_snippets (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  user_id       uuid references auth.users(id)      on delete set null,
  name          text not null,
  statement     text not null,
  is_shared     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists sql_snippets_ws_idx on admin.sql_snippets(workspace_id);

grant select, insert, update, delete on admin.sql_history, admin.sql_snippets to authenticated;
grant all on admin.sql_history, admin.sql_snippets to service_role;

alter table admin.sql_history  enable row level security;
alter table admin.sql_snippets enable row level security;

drop policy if exists sql_history_own on admin.sql_history;
create policy sql_history_own on admin.sql_history for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from admin.workspace_members m
             where m.workspace_id = sql_history.workspace_id and m.user_id = auth.uid()
               and m.role in ('owner','admin'))
);

drop policy if exists sql_snippets_read on admin.sql_snippets;
create policy sql_snippets_read on admin.sql_snippets for select to authenticated using (
  user_id = auth.uid() or (is_shared and exists (
    select 1 from admin.workspace_members m
    where m.workspace_id = sql_snippets.workspace_id and m.user_id = auth.uid()
  ))
);
