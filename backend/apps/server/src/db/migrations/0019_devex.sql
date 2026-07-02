-- Phase 19 — Developer Experience & Ecosystem
-- Project templates (importable starters), personal access tokens,
-- webhook subscriptions (fanout of platform events), and a plugin
-- registry (installed extensions per workspace).
--
-- Every table is workspace-scoped and RLS-protected. Personal access
-- tokens are hashed (sha256 hex) — the raw token is only returned on
-- mint. Webhook secrets are stored as bytea and signed HMAC-SHA256.

create table if not exists public.project_templates (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  description  text not null default '',
  category     text not null default 'starter',
  manifest     jsonb not null default '{}'::jsonb,   -- {tables, functions, envs, seed_sql}
  published    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
grant select        on public.project_templates to anon, authenticated;
grant all           on public.project_templates to service_role;
alter table public.project_templates enable row level security;
create policy tmpl_public_read on public.project_templates
  for select to anon, authenticated using (published = true);

create table if not exists public.personal_access_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid,                                    -- optional scope
  name         text not null,
  token_hash   text not null unique,                    -- sha256 hex
  scopes       text[] not null default array['read']::text[],
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pat_user on public.personal_access_tokens (user_id);
grant select, insert, update on public.personal_access_tokens to authenticated;
grant all on public.personal_access_tokens to service_role;
alter table public.personal_access_tokens enable row level security;
create policy pat_owner on public.personal_access_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create table if not exists public.webhook_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  target_url   text not null,
  event_types  text[] not null default array['*']::text[],
  secret       bytea not null,                          -- HMAC key
  active       boolean not null default true,
  failure_count int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_webhooks_ws on public.webhook_subscriptions (workspace_id);
grant select, insert, update, delete on public.webhook_subscriptions to authenticated;
grant all on public.webhook_subscriptions to service_role;
alter table public.webhook_subscriptions enable row level security;
create policy webhooks_ws on public.webhook_subscriptions
  for all to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true))
  with check (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.webhook_deliveries (
  id            bigserial primary key,
  subscription_id uuid not null references public.webhook_subscriptions(id) on delete cascade,
  event_type    text not null,
  payload       jsonb not null,
  status_code   int,
  response_ms   int,
  error         text,
  attempted_at  timestamptz not null default now()
);
create index if not exists idx_deliveries_sub on public.webhook_deliveries (subscription_id, attempted_at desc);
grant select on public.webhook_deliveries to authenticated;
grant all    on public.webhook_deliveries to service_role;
grant insert on public.webhook_deliveries to pluto_jobs;
alter table public.webhook_deliveries enable row level security;
create policy deliveries_ws on public.webhook_deliveries
  for select to authenticated
  using (subscription_id in (
    select id from public.webhook_subscriptions
    where workspace_id::text = current_setting('request.workspace_id', true)
  ));

create table if not exists public.installed_plugins (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  plugin_slug  text not null,                           -- e.g. "stripe-billing"
  version      text not null,
  config       jsonb not null default '{}'::jsonb,
  enabled      boolean not null default true,
  installed_at timestamptz not null default now(),
  unique (workspace_id, plugin_slug)
);
grant select, insert, update, delete on public.installed_plugins to authenticated;
grant all on public.installed_plugins to service_role;
alter table public.installed_plugins enable row level security;
create policy plugins_ws on public.installed_plugins
  for all to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true))
  with check (workspace_id::text = current_setting('request.workspace_id', true));
