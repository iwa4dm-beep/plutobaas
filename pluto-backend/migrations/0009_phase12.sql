-- ============================================================
-- Phase 12: Realtime Presence, Storage v2, Edge Functions + Cron,
--          Organizations & Teams
-- ============================================================

-- ------------------------------------------------------------
-- Realtime: presence + broadcast history (persistence tier)
-- ------------------------------------------------------------
create schema if not exists realtime;

create table if not exists realtime.channels (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null,
  topic         text not null,
  private       boolean not null default false,
  max_presence  int not null default 500,
  created_at    timestamptz not null default now(),
  unique (project_id, topic)
);

create table if not exists realtime.presence (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null,
  topic         text not null,
  presence_key  text not null,
  user_id       uuid,
  meta          jsonb not null default '{}',
  last_seen_at  timestamptz not null default now(),
  unique (project_id, topic, presence_key)
);
create index if not exists idx_presence_topic on realtime.presence (project_id, topic);
create index if not exists idx_presence_last_seen on realtime.presence (last_seen_at);

create table if not exists realtime.broadcasts (
  id            bigserial primary key,
  project_id    uuid not null,
  topic         text not null,
  event         text not null,
  payload       jsonb not null default '{}',
  sent_at       timestamptz not null default now()
);
create index if not exists idx_broadcasts_topic on realtime.broadcasts (project_id, topic, sent_at desc);

grant usage on schema realtime to authenticated, service_role;
grant select, insert, update, delete on realtime.channels, realtime.presence, realtime.broadcasts to service_role;

-- ------------------------------------------------------------
-- Storage v2: bucket policies, resumable uploads, transforms
-- ------------------------------------------------------------
create table if not exists admin.bucket_policies (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  bucket       text not null,
  role         text not null check (role in ('anon','authenticated','service_role')),
  perms        text[] not null,   -- {read, write, delete, list}
  path_prefix  text not null default '',
  created_at   timestamptz not null default now(),
  unique (project_id, bucket, role, path_prefix)
);

create table if not exists admin.resumable_uploads (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  bucket       text not null,
  object_key   text not null,
  upload_id    text not null,
  size         bigint not null,
  received     bigint not null default 0,
  parts        jsonb not null default '[]',  -- [{part, etag, size}]
  content_type text,
  metadata     jsonb not null default '{}',
  created_by   uuid,
  status       text not null default 'in_progress' check (status in ('in_progress','completed','aborted')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_resumable_status on admin.resumable_uploads (project_id, status);

create table if not exists admin.image_transforms (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  bucket       text not null,
  name         text not null,          -- e.g. thumb, hero
  spec         jsonb not null,         -- { width, height, fit, format, quality }
  created_at   timestamptz not null default now(),
  unique (project_id, bucket, name)
);

grant select, insert, update, delete on
  admin.bucket_policies, admin.resumable_uploads, admin.image_transforms
  to authenticated;
grant all on admin.bucket_policies, admin.resumable_uploads, admin.image_transforms to service_role;

-- ------------------------------------------------------------
-- Edge Functions: cron, secrets, logs
-- ------------------------------------------------------------
create table if not exists admin.function_secrets (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  function_slug text not null,
  name         text not null,
  value        text not null,          -- ciphertext or plain (server encrypts if key set)
  created_at   timestamptz not null default now(),
  unique (project_id, function_slug, name)
);

create table if not exists admin.function_cron (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  function_slug text not null,
  cron_expr    text not null,
  payload      jsonb not null default '{}',
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  next_run_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_fn_cron_next on admin.function_cron (enabled, next_run_at);

create table if not exists admin.function_logs (
  id           bigserial primary key,
  project_id   uuid not null,
  function_slug text not null,
  invocation_id uuid,
  level        text not null default 'info' check (level in ('debug','info','warn','error')),
  message      text not null,
  duration_ms  int,
  status       int,
  meta         jsonb not null default '{}',
  logged_at    timestamptz not null default now()
);
create index if not exists idx_fn_logs_slug on admin.function_logs (project_id, function_slug, logged_at desc);

grant select, insert, update, delete on
  admin.function_secrets, admin.function_cron, admin.function_logs to authenticated;
grant all on admin.function_secrets, admin.function_cron, admin.function_logs to service_role;

-- ------------------------------------------------------------
-- Organizations & Teams
-- ------------------------------------------------------------
create table if not exists admin.organizations (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  billing_email text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);

do $$ begin
  create type admin.org_role as enum ('owner','admin','developer','viewer');
exception when duplicate_object then null; end $$;

create table if not exists admin.organization_members (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references admin.organizations(id) on delete cascade,
  user_id      uuid not null,
  role         admin.org_role not null default 'developer',
  added_at     timestamptz not null default now(),
  unique (org_id, user_id)
);
create index if not exists idx_org_members_user on admin.organization_members (user_id);

create table if not exists admin.organization_invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references admin.organizations(id) on delete cascade,
  email        text not null,
  role         admin.org_role not null default 'developer',
  token        text not null unique,
  invited_by   uuid,
  expires_at   timestamptz not null default (now() + interval '14 days'),
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- Attach org to projects (nullable — legacy projects keep working)
alter table if exists admin.projects add column if not exists org_id uuid references admin.organizations(id);

-- Project-level API keys (opaque tokens with scopes)
create table if not exists admin.project_api_keys (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  name         text not null,
  key_hash     text not null,      -- sha256 hex of the token
  key_prefix   text not null,      -- first 8 chars for UI display
  scopes       text[] not null default '{read}',
  created_by   uuid,
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (project_id, name)
);
create index if not exists idx_api_keys_hash on admin.project_api_keys (key_hash);

grant select, insert, update, delete on
  admin.organizations, admin.organization_members,
  admin.organization_invites, admin.project_api_keys to authenticated;
grant all on
  admin.organizations, admin.organization_members,
  admin.organization_invites, admin.project_api_keys to service_role;

-- Helper: check org role
create or replace function admin.has_org_role(_org uuid, _user uuid, _roles text[])
returns boolean language sql stable security definer set search_path = admin, public as $$
  select exists (
    select 1 from admin.organization_members
    where org_id = _org and user_id = _user and role::text = any(_roles)
  );
$$;
