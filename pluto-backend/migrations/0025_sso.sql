-- Phase 15 · 0025 — SSO (SAML + OIDC) providers + identity links
-- Powers /auth/v1/sso/providers.

create table if not exists auth.sso_providers (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid references admin.workspaces(id) on delete cascade,
  slug           text not null,
  display_name   text not null,
  protocol       text not null check (protocol in ('saml','oidc')),
  -- SAML fields
  entity_id      text,
  sso_url        text,
  x509_cert      text,
  -- OIDC fields
  client_id      text,
  client_secret  text,
  discovery_url  text,
  attr_email     text not null default 'email',
  attr_name      text,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index if not exists sso_providers_ws_idx on auth.sso_providers(workspace_id);

create table if not exists auth.sso_identities (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  provider_id  uuid not null references auth.sso_providers(id) on delete cascade,
  external_id  text not null,
  attributes   jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (provider_id, external_id)
);
create index if not exists sso_identities_user_idx on auth.sso_identities(user_id);

grant usage on schema auth to authenticated;
grant select on auth.sso_providers  to authenticated;
grant select on auth.sso_identities to authenticated;
grant all on auth.sso_providers, auth.sso_identities to service_role;

alter table auth.sso_providers  enable row level security;
alter table auth.sso_identities enable row level security;

drop policy if exists sso_providers_read on auth.sso_providers;
create policy sso_providers_read on auth.sso_providers for select to authenticated using (
  enabled = true and (
    workspace_id is null
    or exists (select 1 from admin.workspace_members m
               where m.workspace_id = auth.sso_providers.workspace_id and m.user_id = auth.uid())
    or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
  )
);

drop policy if exists sso_identities_own on auth.sso_identities;
create policy sso_identities_own on auth.sso_identities for select to authenticated using (
  user_id = auth.uid()
);
