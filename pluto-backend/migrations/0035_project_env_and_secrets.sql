-- Phase C — Project runtime env + secret vault.
--
-- Two tables:
--   • admin.project_env      — PUBLIC key/value pairs written into the deployed
--                              bundle's /env.js (window.__PLUTO_ENV__). Anon
--                              keys, public API URLs, feature flags. NEVER put
--                              a service_role key or credential in here.
--   • admin.project_secrets  — SERVER-ONLY secrets, stored encrypted. Read only
--                              inside edge functions / server routes via the
--                              service role. Reveal-once semantics for the
--                              plaintext (rotate to replace).
--
-- Everything is idempotent.

begin;

-- Self-heal older/partial installs before policies reference workspace owner.
create table if not exists admin.workspaces (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name         text not null,
  owner_id     uuid references auth.users(id) on delete set null,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table if exists admin.projects
  add column if not exists workspace_id uuid references admin.workspaces(id) on delete set null,
  add column if not exists owner_id uuid references auth.users(id) on delete set null;

alter table if exists admin.workspaces
  add column if not exists owner_id uuid references auth.users(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------
-- 1. Public runtime env (safe to ship to the browser)
-- ---------------------------------------------------------------
create table if not exists admin.project_env (
  project_id  uuid not null references admin.projects(id) on delete cascade,
  key         text not null check (key ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  value       text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (project_id, key)
);

create index if not exists project_env_project_idx
  on admin.project_env(project_id);

grant select, insert, update, delete on admin.project_env to authenticated;
grant all on admin.project_env to service_role;

alter table admin.project_env enable row level security;

drop policy if exists project_env_owner on admin.project_env;
create policy project_env_owner on admin.project_env
  for all to authenticated
  using (exists (
    select 1 from admin.projects p
    join admin.workspaces w on w.id = p.workspace_id
    where p.id = project_env.project_id
      and w.owner_id = auth.uid()
  ));

-- Seed default keys for every existing project so the deploy pipeline never
-- ships an empty env.js — the sandbox-worker treats "no rows" as "keep whatever
-- is already in env.js", not "clear it".
insert into admin.project_env (project_id, key, value)
select p.id, 'PLUTO_URL', 'https://api.timescard.cloud'
  from admin.projects p
on conflict (project_id, key) do nothing;

-- ---------------------------------------------------------------
-- 2. Server-only secrets vault (encrypted)
-- ---------------------------------------------------------------
create table if not exists admin.project_secrets (
  id                 bigserial primary key,
  project_id         uuid not null references admin.projects(id) on delete cascade,
  name               text not null check (name ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  value_ciphertext   text not null,  -- AES-256-GCM, base64: iv|tag|ct
  hint               text,           -- short human-readable clue (last 4 chars, description)
  created_at         timestamptz not null default now(),
  created_by         uuid,
  rotated_at         timestamptz,
  last_read_at       timestamptz,
  unique (project_id, name)
);

create index if not exists project_secrets_project_idx
  on admin.project_secrets(project_id);

-- Deliberately NO authenticated grant — secrets are read only by service_role
-- (edge functions) via a security-definer helper. The dashboard writes/rotates
-- through a server route that already runs as service_role.
revoke all on admin.project_secrets from authenticated;
grant all on admin.project_secrets to service_role;

alter table admin.project_secrets enable row level security;

-- Metadata read (no ciphertext) for owners — lets the vault UI list names.
create or replace view admin.project_secrets_metadata as
  select id, project_id, name, hint, created_at, rotated_at, last_read_at
  from admin.project_secrets;

grant select on admin.project_secrets_metadata to authenticated;

-- Owner-scoped metadata policy on the underlying rows so the view respects
-- workspace ownership. The view inherits RLS from the base table.
drop policy if exists project_secrets_owner_meta on admin.project_secrets;
create policy project_secrets_owner_meta on admin.project_secrets
  for select to authenticated
  using (exists (
    select 1 from admin.projects p
    join admin.workspaces w on w.id = p.workspace_id
    where p.id = project_secrets.project_id
      and w.owner_id = auth.uid()
  ));

-- ---------------------------------------------------------------
-- 3. Helper: assemble the runtime env JSON that /env.js will inline.
--    Called by the deploy pipeline; also exposed to the dashboard so the
--    "preview env.js" panel matches what will actually ship.
-- ---------------------------------------------------------------
create or replace function admin.project_runtime_env(_project_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = admin, public
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    from admin.project_env
   where project_id = _project_id
$$;

grant execute on function admin.project_runtime_env(uuid) to authenticated, service_role;

commit;
