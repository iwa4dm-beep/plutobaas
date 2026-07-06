-- Phase 17 · Workspace/project linkage + workspace API tokens
--
-- Fixes dashboard flows that need first-class workspaces, project creation
-- inside a workspace, workspace-scoped API keys, and /tokens/v1/* API tokens.

create schema if not exists admin;

alter table if exists admin.projects
  add column if not exists workspace_id uuid references admin.workspaces(id) on delete set null;

create index if not exists projects_workspace_idx on admin.projects(workspace_id);

-- Backfill legacy projects into a workspace owned by the same user. This keeps
-- older installs working without requiring manual data repair.
do $$
declare
  p record;
  ws uuid;
  ws_slug text;
begin
  for p in select id, name, slug, owner_id from admin.projects where workspace_id is null loop
    select id into ws
      from admin.workspaces
      where owner_id is not distinct from p.owner_id
      order by created_at asc
      limit 1;

    if ws is null then
      ws_slug := left(coalesce(nullif(regexp_replace(lower(p.slug), '[^a-z0-9-]+', '-', 'g'), ''), 'workspace') || '-' || replace(p.id::text, '-', ''), 63);
      if ws_slug !~ '^[a-z][a-z0-9-]{1,62}$' then
        ws_slug := 'workspace-' || left(replace(p.id::text, '-', ''), 12);
      end if;

      insert into admin.workspaces (slug, name, owner_id)
      values (ws_slug, coalesce(p.name, 'Workspace'), p.owner_id)
      on conflict (slug) do update set updated_at = now()
      returning id into ws;
    end if;

    update admin.projects set workspace_id = ws where id = p.id;

    if p.owner_id is not null then
      insert into admin.workspace_members (workspace_id, user_id, role)
      values (ws, p.owner_id, 'owner')
      on conflict (workspace_id, user_id) do nothing;
    end if;
  end loop;
end $$;

create table if not exists admin.workspace_tokens (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references admin.workspaces(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  prefix       text not null,
  scopes       text[] not null default '{}',
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

create index if not exists workspace_tokens_workspace_idx on admin.workspace_tokens(workspace_id);
create index if not exists workspace_tokens_prefix_idx on admin.workspace_tokens(prefix);
create index if not exists workspace_tokens_active_idx on admin.workspace_tokens(workspace_id, expires_at)
  where revoked_at is null;

grant select, insert, update, delete on admin.workspace_tokens to authenticated;
grant all on admin.workspace_tokens to service_role;