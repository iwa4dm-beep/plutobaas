-- Phase 10: Backups, Webhooks, Search/Vector, Billing & Observability
-- =====================================================================

-- ---------- BACKUPS ----------
create table if not exists admin.backup_jobs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references admin.projects(id) on delete cascade,
  kind           text not null check (kind in ('full','schema','data','pitr')),
  status         text not null default 'pending' check (status in ('pending','running','succeeded','failed')),
  storage_path   text,
  size_bytes     bigint,
  error_message  text,
  requested_by   uuid,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists backup_jobs_project_idx on admin.backup_jobs (project_id, created_at desc);

create table if not exists admin.backup_schedules (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references admin.projects(id) on delete cascade,
  cron_expr    text not null,               -- e.g. "0 3 * * *"
  kind         text not null default 'full',
  retention_days integer not null default 14,
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  next_run_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------- WEBHOOKS ----------
create table if not exists admin.webhook_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references admin.projects(id) on delete cascade,
  name         text not null,
  target_url   text not null,
  events       text[] not null,             -- e.g. {'row.inserted','row.updated','auth.user.created'}
  filter_schema text,
  filter_table  text,
  secret       text not null,               -- HMAC signing key
  enabled      boolean not null default true,
  max_retries  integer not null default 5,
  timeout_ms   integer not null default 10000,
  created_at   timestamptz not null default now()
);
create index if not exists webhook_sub_project_idx on admin.webhook_subscriptions (project_id);

create table if not exists admin.webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references admin.webhook_subscriptions(id) on delete cascade,
  event_type      text not null,
  payload         jsonb not null,
  attempt         integer not null default 0,
  status          text not null default 'pending' check (status in ('pending','delivered','failed','dead')),
  response_status integer,
  response_body   text,
  duration_ms     integer,
  next_retry_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists webhook_deliv_sub_idx    on admin.webhook_deliveries (subscription_id, created_at desc);
create index if not exists webhook_deliv_status_idx on admin.webhook_deliveries (status, next_retry_at);

-- ---------- SEARCH / VECTOR ----------
-- Ensure pgvector is available if the operator has it installed.
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    execute 'create extension if not exists vector';
  end if;
end $$;

create table if not exists admin.search_configs (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references admin.projects(id) on delete cascade,
  schema_name  text not null,
  table_name   text not null,
  column_name  text not null,               -- source text column
  tsv_column   text not null default 'search_tsv',
  language     text not null default 'english',
  created_at   timestamptz not null default now(),
  unique (project_id, schema_name, table_name, column_name)
);

create table if not exists admin.vector_configs (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references admin.projects(id) on delete cascade,
  schema_name  text not null,
  table_name   text not null,
  column_name  text not null,
  dimensions   integer not null,
  metric       text not null default 'cosine' check (metric in ('cosine','l2','ip')),
  index_kind   text not null default 'ivfflat' check (index_kind in ('ivfflat','hnsw','none')),
  created_at   timestamptz not null default now(),
  unique (project_id, schema_name, table_name, column_name)
);

-- ---------- BILLING / QUOTAS / USAGE ----------
create table if not exists admin.usage_counters (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references admin.projects(id) on delete cascade,
  metric       text not null,               -- 'api.requests','db.rows.read','db.rows.written','storage.bytes','fn.invocations','realtime.messages','egress.bytes'
  period       text not null,               -- 'YYYY-MM' or 'YYYY-MM-DD'
  value        bigint not null default 0,
  updated_at   timestamptz not null default now(),
  unique (project_id, metric, period)
);
create index if not exists usage_counters_lookup on admin.usage_counters (project_id, period);

create table if not exists admin.quotas (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references admin.projects(id) on delete cascade,
  metric       text not null,
  soft_limit   bigint,
  hard_limit   bigint,
  "window"     text not null default 'month' check ("window" in ('day','month')),
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (project_id, metric, "window")
);

create table if not exists admin.alert_rules (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references admin.projects(id) on delete cascade,
  name         text not null,
  metric       text not null,               -- prometheus metric name or pluto counter
  operator     text not null check (operator in ('>','>=','<','<=','=')),
  threshold    double precision not null,
  window_seconds integer not null default 300,
  channel      text not null default 'email',    -- 'email','webhook'
  target       text not null,               -- email address or webhook URL
  enabled      boolean not null default true,
  last_fired_at timestamptz,
  created_at   timestamptz not null default now()
);

-- Helper: bump a usage counter atomically
create or replace function admin.bump_usage(
  _project uuid, _metric text, _delta bigint, _period text default to_char(now(),'YYYY-MM')
) returns void
language plpgsql
security definer
set search_path = admin, public
as $$
begin
  insert into admin.usage_counters(project_id, metric, period, value, updated_at)
  values (_project, _metric, _period, _delta, now())
  on conflict (project_id, metric, period)
  do update set value = admin.usage_counters.value + excluded.value, updated_at = now();
end;
$$;

grant select, insert, update, delete on all tables in schema admin to service_role;
