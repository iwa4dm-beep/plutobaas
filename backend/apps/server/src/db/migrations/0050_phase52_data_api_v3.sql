-- Phase 52 — Data API v3: nested writes, computed fields, generated types,
-- schema introspection cache.

-- Computed-field registry — a virtual column expressed as a SQL expression
-- evaluated against the base table row. Consumed by the /rest/v3 reader.
create table if not exists public.dapi3_computed_fields (
  id           uuid        primary key default gen_random_uuid(),
  workspace_id uuid        not null,
  schema_name  text        not null,
  table_name   text        not null,
  field_name   text        not null,
  sql_expr     text        not null,
  return_type  text        not null default 'text',
  created_at   timestamptz not null default now(),
  unique (workspace_id, schema_name, table_name, field_name)
);
create index if not exists dapi3_computed_ws_idx
  on public.dapi3_computed_fields(workspace_id, schema_name, table_name);

-- Schema introspection cache — a serialized snapshot of tables/columns/relations
-- used by generated types and the writer to validate nested payloads without
-- hitting pg_catalog on every call.
create table if not exists public.dapi3_schema_cache (
  workspace_id uuid        not null,
  schema_name  text        not null,
  digest       text        not null,
  snapshot     jsonb       not null,
  captured_at  timestamptz not null default now(),
  primary key (workspace_id, schema_name)
);

grant select, insert, update, delete on public.dapi3_computed_fields to authenticated;
grant select, insert, update, delete on public.dapi3_schema_cache    to authenticated;
grant all on public.dapi3_computed_fields, public.dapi3_schema_cache to service_role;

alter table public.dapi3_computed_fields enable row level security;
alter table public.dapi3_schema_cache    enable row level security;

create policy dapi3_computed_service on public.dapi3_computed_fields
  for all to service_role using (true) with check (true);
create policy dapi3_cache_service on public.dapi3_schema_cache
  for all to service_role using (true) with check (true);
