-- Phase 15 · 0016 — Workspaces (multi-tenant) + rollup stats view
--
-- Powers /admin/v1/workspaces and /admin/v1/stats. Idempotent.

create schema if not exists admin;

create table if not exists admin.workspaces (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name         text not null,
  owner_id     uuid references auth.users(id) on delete set null,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Self-heal older/partial installs where admin.workspaces existed before this
-- migration but did not yet have the Phase 15 columns. CREATE TABLE IF NOT
-- EXISTS does not add missing columns, so every referenced column must be
-- asserted before indexes, policies, and later migrations use it.
alter table admin.workspaces
  add column if not exists owner_id uuid references auth.users(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists workspaces_owner_idx on admin.workspaces(owner_id);

create table if not exists admin.workspace_members (
  workspace_id uuid not null references admin.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id)      on delete cascade,
  role         text not null check (role in ('owner','admin','developer','viewer')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists ws_members_user_idx on admin.workspace_members(user_id);

grant select, insert, update, delete on admin.workspaces        to authenticated;
grant select, insert, update, delete on admin.workspace_members to authenticated;
grant all on admin.workspaces, admin.workspace_members          to service_role;

alter table admin.workspaces        enable row level security;
alter table admin.workspace_members enable row level security;

drop policy if exists workspaces_read on admin.workspaces;
create policy workspaces_read on admin.workspaces
  for select to authenticated using (
    exists (select 1 from admin.workspace_members m
            where m.workspace_id = id and m.user_id = auth.uid())
    or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
  );

drop policy if exists ws_members_read on admin.workspace_members;
create policy ws_members_read on admin.workspace_members
  for select to authenticated using (
    user_id = auth.uid()
    or exists (select 1 from admin.workspace_members m
               where m.workspace_id = workspace_id and m.user_id = auth.uid()
                 and m.role in ('owner','admin'))
    or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
  );

-- Aggregated stats view for /admin/v1/stats
create or replace view admin.v_stats as
select
  (select count(*)::bigint from auth.users)              as users,
  (select count(*)::bigint from admin.workspaces
     where archived_at is null)                          as workspaces,
  (select coalesce(count(*),0)::bigint from admin.projects) as projects,
  (select coalesce(count(*),0)::bigint from public.buckets
     where true)                                          as buckets,
  (select coalesce(sum(size),0)::bigint from public.objects) as storage_bytes,
  (select coalesce(count(*),0)::bigint from public.objects)  as objects,
  now() as ts;

grant select on admin.v_stats to authenticated, service_role;
