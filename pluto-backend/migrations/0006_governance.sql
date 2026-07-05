-- Phase 9 — Governance: audit log, table grants, migrations versioning.

-- ============================================================
-- 1. Audit log
-- ============================================================
create table if not exists admin.audit_log (
  id             bigserial primary key,
  actor_id       uuid,
  project_id     uuid,
  action         text not null,
  resource_type  text not null,
  resource_id    text,
  params         jsonb not null default '{}'::jsonb,
  result         text not null check (result in ('ok','error','blocked')),
  duration_ms    integer,
  error_message  text,
  created_at     timestamptz not null default now()
);

create index if not exists audit_log_created_at_idx on admin.audit_log (created_at desc);
create index if not exists audit_log_project_idx    on admin.audit_log (project_id, created_at desc);
create index if not exists audit_log_actor_idx      on admin.audit_log (actor_id, created_at desc);
create index if not exists audit_log_action_idx     on admin.audit_log (action);
create index if not exists audit_log_params_gin     on admin.audit_log using gin (params);

-- ============================================================
-- 2. Table-level grants
-- ============================================================
do $$ begin
  create type admin.table_perm as enum ('read','write','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type admin.principal_kind as enum ('user','api_key_role');
exception when duplicate_object then null; end $$;

create table if not exists admin.table_grants (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references admin.projects(id) on delete cascade,
  schema_name    text not null,
  table_name     text not null,
  perm           admin.table_perm not null,
  principal_kind admin.principal_kind not null,
  principal_id   text not null,
  granted_by     uuid,
  created_at     timestamptz not null default now(),
  unique (project_id, schema_name, table_name, perm, principal_kind, principal_id)
);
create index if not exists table_grants_lookup_idx
  on admin.table_grants (project_id, schema_name, table_name);

-- perm-check helper (security definer so callers don't need direct table select)
create or replace function admin.check_table_perm(
  _project_id uuid, _schema text, _table text,
  _action text,       -- 'read' | 'write' | 'admin'
  _actor_id uuid,
  _api_role text      -- 'anon' | 'authenticated' | 'service_role' | null
) returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  needed admin.table_perm;
  has_it boolean;
begin
  if _api_role = 'service_role' then return true; end if;

  needed := case _action
              when 'read'  then 'read'::admin.table_perm
              when 'write' then 'write'::admin.table_perm
              when 'admin' then 'admin'::admin.table_perm
              else 'admin'::admin.table_perm
            end;

  -- If no grants exist for the table, allow (project-level auth already ran).
  perform 1 from admin.table_grants
    where project_id = _project_id and schema_name = _schema and table_name = _table;
  if not found then return true; end if;

  select exists (
    select 1 from admin.table_grants g
    where g.project_id = _project_id
      and g.schema_name = _schema and g.table_name = _table
      and (
        g.perm = needed
        or (needed = 'read'::admin.table_perm and g.perm in ('write','admin'))
        or (needed = 'write'::admin.table_perm and g.perm = 'admin')
      )
      and (
        (g.principal_kind = 'user'         and _actor_id is not null and g.principal_id = _actor_id::text)
     or (g.principal_kind = 'api_key_role' and _api_role  is not null and g.principal_id = _api_role)
      )
  ) into has_it;
  return coalesce(has_it, false);
end $$;

-- ============================================================
-- 3. Migration versioning
-- ============================================================
create table if not exists admin.migrations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid references admin.projects(id) on delete cascade,
  version        bigint not null,
  name           text not null,
  up_sql         text not null,
  down_sql       text not null default '',
  checksum       text not null,
  applied_at     timestamptz,
  applied_by     uuid,
  rolled_back_at timestamptz,
  rolled_back_by uuid,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (project_id, version)
);
create index if not exists migrations_project_idx on admin.migrations (project_id, version);
create index if not exists migrations_status_idx  on admin.migrations (applied_at, rolled_back_at);
