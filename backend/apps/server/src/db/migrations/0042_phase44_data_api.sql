-- Phase 44 — Data API depth: DB Webhooks + Foreign Data Wrappers registry.
--
-- Adds:
--   * db_webhooks             — user-registered outbound webhooks fired on
--                               table INSERT/UPDATE/DELETE. HMAC-signed
--                               with per-webhook secret; retried with
--                               exponential backoff by the dispatcher.
--   * db_webhook_deliveries   — per-attempt log (status, response, next_retry_at).
--   * fdw_servers             — foreign server registry (postgres_fdw / file_fdw).
--   * fdw_tables              — foreign tables imported from a server, with
--                               local schema/name for querying via Data API.
--
-- Embedded relations (?select=col,rel(*)) live in code — they read the
-- existing information_schema.foreign_key catalog at request time and
-- do not require a schema of their own.

create table if not exists public.db_webhooks (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  name           text not null,
  schema_name    text not null default 'public',
  table_name     text not null,
  events         text[] not null,     -- subset of {INSERT,UPDATE,DELETE}
  url            text not null,
  secret         text not null,       -- HMAC-SHA256 signing secret
  headers        jsonb not null default '{}'::jsonb,
  max_retries    int  not null default 5 check (max_retries between 0 and 20),
  timeout_ms     int  not null default 10000 check (timeout_ms between 1000 and 60000),
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists ix_db_webhooks_target
  on public.db_webhooks(schema_name, table_name) where enabled;

revoke all on public.db_webhooks from authenticated, anon;
grant  all on public.db_webhooks to service_role;
alter table public.db_webhooks enable row level security;

create table if not exists public.db_webhook_deliveries (
  id              bigserial primary key,
  webhook_id      uuid not null references public.db_webhooks(id) on delete cascade,
  event_type      text not null,
  payload         jsonb not null,
  attempt         int  not null default 0,
  status          text not null default 'pending', -- pending|sent|failed|dead
  http_status     int,
  response_body   text,
  error_message   text,
  next_retry_at   timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists ix_dwd_due
  on public.db_webhook_deliveries(status, next_retry_at)
  where status = 'pending';
create index if not exists ix_dwd_webhook
  on public.db_webhook_deliveries(webhook_id, id desc);

revoke all on public.db_webhook_deliveries from authenticated, anon;
grant  all on public.db_webhook_deliveries to service_role;
alter table public.db_webhook_deliveries enable row level security;

create table if not exists public.fdw_servers (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  name           text not null,
  wrapper        text not null,       -- 'postgres_fdw' | 'file_fdw'
  options        jsonb not null default '{}'::jsonb,  -- host, port, dbname, filename…
  user_mapping   jsonb not null default '{}'::jsonb,  -- {user, password}
  created_at     timestamptz not null default now(),
  unique (workspace_id, name)
);

revoke all on public.fdw_servers from authenticated, anon;
grant  all on public.fdw_servers to service_role;
alter table public.fdw_servers enable row level security;

create table if not exists public.fdw_tables (
  id             uuid primary key default gen_random_uuid(),
  server_id      uuid not null references public.fdw_servers(id) on delete cascade,
  local_schema   text not null default 'public',
  local_name     text not null,
  remote_schema  text,
  remote_name    text not null,
  columns        jsonb not null default '[]'::jsonb,  -- [{name,type}]
  created_at     timestamptz not null default now(),
  unique (local_schema, local_name)
);
create index if not exists ix_fdw_tables_server on public.fdw_tables(server_id);

revoke all on public.fdw_tables from authenticated, anon;
grant  all on public.fdw_tables to service_role;
alter table public.fdw_tables enable row level security;
