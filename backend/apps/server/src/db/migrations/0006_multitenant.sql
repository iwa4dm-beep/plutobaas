-- Phase 8: multi-tenant workspaces + SQL runner history.
--
-- Workspaces are the top-level isolation boundary. Each workspace has
-- its own set of API keys (anon + service_role), its own members, and
-- owns its data rows through a `workspace_id` column. RLS policies
-- honour `pluto.workspace_id` in addition to `pluto.user_id` so a
-- request made with workspace A's anon key can never see workspace B.
--
-- The env-supplied ANON_KEY / SERVICE_ROLE_KEY continue to work: they
-- resolve to the reserved "root" workspace (slug = 'root') created
-- below on first boot, so existing deployments keep functioning while
-- we grow additional tenants alongside.

create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null check (slug ~ '^[a-z][a-z0-9_-]{1,40}$'),
  name        text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.users(id) on delete set null,
  archived_at timestamptz
);

grant select on public.workspaces to authenticated;
grant all    on public.workspaces to service_role;
alter table public.workspaces enable row level security;

-- Seed the reserved root workspace so env keys have a home.
insert into public.workspaces (id, slug, name)
values ('00000000-0000-0000-0000-000000000001', 'root', 'Root workspace')
on conflict (slug) do nothing;

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references public.users(id)      on delete cascade,
  role         text not null default 'member'
                 check (role in ('owner','admin','member','viewer')),
  invited_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

grant select, insert, update, delete on public.workspace_members to authenticated;
grant all on public.workspace_members to service_role;
alter table public.workspace_members enable row level security;

-- Per-workspace API keys. We store the SHA-256 of the plaintext key
-- so a database dump cannot be replayed. The plaintext is returned
-- exactly once at mint time (see /admin/v1/workspaces/:id/keys).
create table if not exists public.workspace_api_keys (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  kind          text not null check (kind in ('anon','service_role')),
  name          text not null,
  key_prefix    text not null,          -- first 12 chars, e.g. "pk_anon_ab12"
  key_hash      text not null unique,   -- sha256(plaintext)
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  use_count     bigint not null default 0
);
create index if not exists workspace_api_keys_ws_idx on public.workspace_api_keys (workspace_id, revoked_at);

grant select on public.workspace_api_keys to authenticated;
grant all    on public.workspace_api_keys to service_role;
alter table public.workspace_api_keys enable row level security;
drop policy if exists ws_keys_service_only on public.workspace_api_keys;
create policy ws_keys_service_only on public.workspace_api_keys
  for all to authenticated using (false) with check (false);

-- Attach workspace ownership to existing tenant-scoped tables. We
-- default new rows to the root workspace so old code keeps working
-- until callers start supplying an explicit workspace context.
alter table public.buckets
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;
update public.buckets set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table public.buckets alter column workspace_id set not null;
alter table public.buckets alter column workspace_id set default '00000000-0000-0000-0000-000000000001';

alter table public.objects
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;
update public.objects set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table public.objects alter column workspace_id set not null;

alter table public.api_logs
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;

alter table public.audit_events
  add column if not exists workspace_id uuid references public.workspaces(id) on delete set null;

alter table public.edge_functions
  add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;
update public.edge_functions set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;

-- Helper: read the resolved workspace id for the current request.
create or replace function public.current_workspace_id()
returns uuid language sql stable as $$
  select nullif(current_setting('pluto.workspace_id', true), '')::uuid
$$;

-- Membership helper — used by RLS to check "current user is in workspace X".
create or replace function public.is_workspace_member(_workspace uuid, _min_role text default 'viewer')
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
     where m.workspace_id = _workspace
       and m.user_id = public.current_user_id()
       and case _min_role
             when 'owner'  then m.role = 'owner'
             when 'admin'  then m.role in ('owner','admin')
             when 'member' then m.role in ('owner','admin','member')
             else true      -- 'viewer'
           end
  )
$$;

-- Tighten RLS for the newly-tenant-aware tables. Every read/write is
-- constrained to the caller's active workspace (from the GUC set by
-- the API-key resolver).
drop policy if exists workspaces_member_read on public.workspaces;
create policy workspaces_member_read on public.workspaces
  for select to authenticated
  using (public.is_admin() or public.is_workspace_member(id));

drop policy if exists workspace_members_self_read on public.workspace_members;
create policy workspace_members_self_read on public.workspace_members
  for select to authenticated
  using (user_id = public.current_user_id() or public.is_workspace_member(workspace_id, 'admin'));

drop policy if exists buckets_workspace_scope on public.buckets;
create policy buckets_workspace_scope on public.buckets
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

drop policy if exists objects_workspace_scope on public.objects;
create policy objects_workspace_scope on public.objects
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- +migrate down
drop policy if exists objects_workspace_scope       on public.objects;
drop policy if exists buckets_workspace_scope       on public.buckets;
drop policy if exists workspace_members_self_read   on public.workspace_members;
drop policy if exists workspaces_member_read        on public.workspaces;
drop function if exists public.is_workspace_member(uuid, text);
drop function if exists public.current_workspace_id();
alter table if exists public.edge_functions drop column if exists workspace_id;
alter table if exists public.audit_events   drop column if exists workspace_id;
alter table if exists public.api_logs       drop column if exists workspace_id;
alter table if exists public.objects        drop column if exists workspace_id;
alter table if exists public.buckets        drop column if exists workspace_id;
drop table if exists public.workspace_api_keys;
drop table if exists public.workspace_members;
delete from public.workspaces where slug = 'root';
drop table if exists public.workspaces;
