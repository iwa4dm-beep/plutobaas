-- Phase 59 — Data API v4 (RPC catalog + query cursors audit).
--
-- Persists RPC contract definitions (name, description, JSON schemas) per
-- workspace so the OpenAPI emitter can rebuild without reloading code.
-- The `data_api_v4_query_cursors` table records last-observed cursors per
-- (workspace, endpoint) so operators can inspect pagination progress and
-- detect stalled iterators.

create table if not exists public.data_api_v4_rpcs (
  workspace_id  uuid not null,
  name          text not null,
  description   text,
  input_schema  jsonb not null,
  output_schema jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, name)
);

grant select, insert, update, delete on public.data_api_v4_rpcs to authenticated;
grant all on public.data_api_v4_rpcs to service_role;
alter table public.data_api_v4_rpcs enable row level security;

create table if not exists public.data_api_v4_query_cursors (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  endpoint      text not null,
  cursor        text not null,
  observed_at   timestamptz not null default now()
);
create index if not exists idx_dav4_cursors_ws_endpoint
  on public.data_api_v4_query_cursors(workspace_id, endpoint, observed_at desc);

grant select, insert on public.data_api_v4_query_cursors to authenticated;
grant all on public.data_api_v4_query_cursors to service_role;
alter table public.data_api_v4_query_cursors enable row level security;
