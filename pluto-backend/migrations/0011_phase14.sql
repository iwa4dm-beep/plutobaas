-- Phase 14: Vault & Secrets, Data Studio, Marketplace & Extensions
set search_path = admin, public;

-- =========================================================
-- Vault & Secrets Management (KMS-style envelope encryption)
-- =========================================================
create table if not exists admin.vault_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references admin.projects(id) on delete cascade,
  alias text not null,
  wrapped_dek bytea not null,       -- DEK wrapped by KEK (env: PLUTO_VAULT_KEK)
  kek_id text not null default 'primary',
  algo text not null default 'aes-256-gcm',
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (project_id, alias)
);

create table if not exists admin.vault_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references admin.projects(id) on delete cascade,
  environment text not null default 'production' check (environment in ('development','staging','production')),
  name text not null,
  current_version int not null default 1,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, environment, name)
);

create table if not exists admin.vault_secret_versions (
  id uuid primary key default gen_random_uuid(),
  secret_id uuid not null references admin.vault_secrets(id) on delete cascade,
  version int not null,
  key_id uuid not null references admin.vault_keys(id),
  iv bytea not null,
  ciphertext bytea not null,
  tag bytea not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (secret_id, version)
);

create table if not exists admin.vault_access_log (
  id bigserial primary key,
  secret_id uuid not null references admin.vault_secrets(id) on delete cascade,
  version int,
  actor_id uuid,
  action text not null check (action in ('read','write','rotate','delete')),
  ip inet,
  at timestamptz not null default now()
);

create table if not exists admin.vault_db_credentials (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references admin.projects(id) on delete cascade,
  role_prefix text not null default 'pluto_dyn_',
  username text not null unique,
  password_secret_id uuid references admin.vault_secrets(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- =========================================================
-- Data Studio (saved queries, snippets)
-- =========================================================
create table if not exists admin.sql_snippets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references admin.projects(id) on delete cascade,
  owner_id uuid,
  name text not null,
  description text,
  sql text not null,
  is_shared boolean not null default false,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists admin.saved_queries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references admin.projects(id) on delete cascade,
  owner_id uuid,
  name text not null,
  sql text not null,
  params jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);

-- =========================================================
-- Marketplace & Extensions
-- =========================================================
create table if not exists admin.marketplace_extensions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  category text not null default 'plugin' check (category in ('plugin','template','starter','webhook')),
  author text,
  version text not null default '0.1.0',
  manifest jsonb not null default '{}'::jsonb,
  install_count int not null default 0,
  is_official boolean not null default false,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists admin.project_extensions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references admin.projects(id) on delete cascade,
  extension_id uuid not null references admin.marketplace_extensions(id) on delete cascade,
  version text not null,
  status text not null default 'active' check (status in ('active','disabled','uninstalled')),
  config jsonb not null default '{}'::jsonb,
  installed_by uuid,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, extension_id)
);

create table if not exists admin.extension_events (
  id bigserial primary key,
  project_extension_id uuid not null references admin.project_extensions(id) on delete cascade,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'ok',
  at timestamptz not null default now()
);

-- Grants
grant usage on schema admin to authenticated;
grant select, insert, update, delete on
  admin.vault_keys, admin.vault_secrets, admin.vault_secret_versions,
  admin.vault_access_log, admin.vault_db_credentials,
  admin.sql_snippets, admin.saved_queries,
  admin.marketplace_extensions, admin.project_extensions, admin.extension_events
  to authenticated;
grant usage, select on all sequences in schema admin to authenticated;

-- Seed a few official marketplace extensions (idempotent)
insert into admin.marketplace_extensions (slug, name, description, category, author, version, is_official, manifest)
values
  ('starter-saas', 'SaaS Starter', 'Auth + billing + org management starter', 'starter', 'pluto', '1.0.0', true,
   '{"features":["auth","billing","orgs"],"routes":["/auth","/billing"]}'::jsonb),
  ('template-blog', 'Blog Template', 'Blog schema with posts, tags, comments', 'template', 'pluto', '1.0.0', true,
   '{"tables":["posts","tags","comments"]}'::jsonb),
  ('webhook-slack', 'Slack Webhook', 'Forward audit events to a Slack channel', 'webhook', 'pluto', '1.0.0', true,
   '{"config":{"webhook_url":"string"},"events":["audit.*"]}'::jsonb),
  ('plugin-image-optimizer', 'Image Optimizer', 'Resize + WebP conversion on upload', 'plugin', 'pluto', '1.0.0', true,
   '{"hooks":["storage.upload.after"]}'::jsonb)
on conflict (slug) do nothing;
