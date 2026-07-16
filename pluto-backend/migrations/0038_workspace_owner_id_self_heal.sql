-- 0038_workspace_owner_id_self_heal.sql
--
-- Durable repair for production databases where workspace/project tables were
-- created by older bootstrap code but missed owner_id. Later deploy, env, and
-- quota migrations depend on these columns existing.

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

create table if not exists admin.workspace_members (
  workspace_id uuid not null references admin.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id)      on delete cascade,
  role         text not null check (role in ('owner','admin','developer','viewer')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

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