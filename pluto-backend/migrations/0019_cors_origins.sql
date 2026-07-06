-- Phase 15 · 0019 — CORS allow-list per workspace
-- Powers /admin/v1/cors/origins.

create table if not exists admin.cors_origins (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  origin        text not null,       -- e.g. https://app.example.com
  methods       text[] not null default array['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  headers       text[] not null default array['content-type','authorization','apikey'],
  credentials   boolean not null default true,
  max_age       integer not null default 86400,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (workspace_id, origin)
);
create index if not exists cors_origins_ws_idx on admin.cors_origins(workspace_id);

grant select, insert, update, delete on admin.cors_origins to authenticated;
grant all on admin.cors_origins to service_role;
alter table admin.cors_origins enable row level security;

drop policy if exists cors_origins_read on admin.cors_origins;
create policy cors_origins_read on admin.cors_origins for select to authenticated using (
  workspace_id is null
  or exists (select 1 from admin.workspace_members m
             where m.workspace_id = cors_origins.workspace_id and m.user_id = auth.uid())
  or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
);
