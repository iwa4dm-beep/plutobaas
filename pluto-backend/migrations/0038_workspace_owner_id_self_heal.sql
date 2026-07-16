-- 0038_workspace_owner_id_self_heal.sql
--
-- Durable repair for production databases where workspace/project tables were
-- created by older bootstrap code but missed owner_id. Later deploy, env, and
-- quota migrations depend on these columns existing.

create schema if not exists admin;

alter table if exists admin.projects
  add column if not exists owner_id uuid references auth.users(id) on delete set null,
  add column if not exists created_at timestamptz default now();

alter table if exists admin.workspaces
  add column if not exists owner_id uuid references auth.users(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists workspaces_owner_idx on admin.workspaces(owner_id);
create index if not exists projects_owner_idx on admin.projects(owner_id);