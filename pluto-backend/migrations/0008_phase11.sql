-- Phase 11: Branching, GraphQL, CLI/SDK, Advanced Auth
-- =====================================================================

-- ---------- DATABASE BRANCHING ----------
create table if not exists admin.branches (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references admin.projects(id) on delete cascade,
  name            text not null,                       -- e.g. "preview/feature-x"
  parent_branch   text default 'main',
  db_name         text not null,                       -- physical postgres database name
  status          text not null default 'creating'
                    check (status in ('creating','ready','promoting','archived','failed')),
  git_ref         text,                                -- optional git branch/sha for previews
  created_by      uuid,
  promoted_at     timestamptz,
  error_message   text,
  created_at      timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists admin.branch_diffs (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references admin.branches(id) on delete cascade,
  computed_at     timestamptz not null default now(),
  summary         jsonb not null,                      -- {tables_added, tables_removed, columns_changed, ...}
  detail          text                                  -- human-readable diff
);

-- ---------- GRAPHQL ----------
create table if not exists admin.graphql_configs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references admin.projects(id) on delete cascade unique,
  schemas       text[] not null default array['public'],
  enable_subs   boolean not null default false,
  max_depth     integer not null default 10,
  max_complexity integer not null default 1000,
  cached_sdl    text,
  updated_at    timestamptz not null default now()
);

-- ---------- ADVANCED AUTH ----------
create table if not exists admin.oauth_providers (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references admin.projects(id) on delete cascade,
  provider      text not null check (provider in ('google','github','apple','azure','discord','facebook','custom')),
  client_id     text not null,
  client_secret text not null,
  redirect_uri  text not null,
  scopes        text[] not null default array['openid','email','profile'],
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (project_id, provider)
);

-- Store MFA factors per user (auth schema — already exists)
create table if not exists auth.mfa_factors (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  factor_type   text not null check (factor_type in ('totp','webauthn','sms')),
  friendly_name text,
  secret        text,                       -- base32 TOTP secret (encrypt at rest in prod)
  status        text not null default 'unverified' check (status in ('unverified','verified')),
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists mfa_factors_user_idx on auth.mfa_factors (user_id);

create table if not exists auth.mfa_challenges (
  id            uuid primary key default gen_random_uuid(),
  factor_id     uuid not null references auth.mfa_factors(id) on delete cascade,
  verified      boolean not null default false,
  expires_at    timestamptz not null default (now() + interval '5 minutes'),
  created_at    timestamptz not null default now()
);

create table if not exists admin.saml_providers (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references admin.projects(id) on delete cascade,
  name               text not null,
  entity_id          text not null,                     -- IdP entity ID
  sso_url            text not null,                     -- IdP SSO endpoint
  x509_cert          text not null,                     -- IdP signing certificate (PEM)
  attribute_mapping  jsonb not null default '{"email":"email","name":"name"}'::jsonb,
  enabled            boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (project_id, name)
);

-- ---------- SDK GENERATION LOG ----------
create table if not exists admin.sdk_generations (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references admin.projects(id) on delete cascade,
  language      text not null default 'typescript',
  version       text not null,
  size_bytes    integer,
  requested_by  uuid,
  created_at    timestamptz not null default now()
);

grant select, insert, update, delete on all tables in schema admin to service_role;
grant select, insert, update, delete on all tables in schema auth  to service_role;
