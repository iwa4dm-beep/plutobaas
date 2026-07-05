-- ============================================================
-- Phase 13: Queues, AI Gateway, Read Replicas, Compliance (GDPR)
-- Reuses existing pgvector columns (see search.ts) — no duplication.
-- ============================================================

-- ------------------------------------------------------------
-- Queues & background jobs (durable, with retries + DLQ)
-- ------------------------------------------------------------
create table if not exists admin.queues (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null,
  name            text not null,
  max_concurrency int not null default 5,
  visibility_sec  int not null default 30,   -- ack window after claim
  max_attempts    int not null default 5,
  created_at      timestamptz not null default now(),
  unique (project_id, name)
);

do $$ begin
  create type admin.job_status as enum ('pending','claimed','succeeded','failed','dlq');
exception when duplicate_object then null; end $$;

create table if not exists admin.jobs (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null,
  queue_id        uuid not null references admin.queues(id) on delete cascade,
  payload         jsonb not null default '{}',
  status          admin.job_status not null default 'pending',
  attempts        int not null default 0,
  max_attempts    int not null default 5,
  run_after       timestamptz not null default now(),
  claimed_at      timestamptz,
  claimed_by      text,
  visibility_until timestamptz,
  last_error      text,
  result          jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_jobs_claim on admin.jobs (queue_id, status, run_after) where status in ('pending','claimed');
create index if not exists idx_jobs_status on admin.jobs (project_id, status);

-- Claim next N jobs atomically (skip locked).
create or replace function admin.claim_jobs(_queue uuid, _worker text, _batch int, _vis_sec int)
returns setof admin.jobs language plpgsql as $$
begin
  return query
  with picked as (
    select id from admin.jobs
    where queue_id = _queue and status = 'pending' and run_after <= now()
    order by run_after
    for update skip locked
    limit greatest(_batch, 1)
  )
  update admin.jobs j
  set status = 'claimed', attempts = attempts + 1,
      claimed_at = now(), claimed_by = _worker,
      visibility_until = now() + make_interval(secs => _vis_sec),
      updated_at = now()
  from picked
  where j.id = picked.id
  returning j.*;
end $$;

grant select, insert, update, delete on admin.queues, admin.jobs to authenticated;
grant all on admin.queues, admin.jobs to service_role;

-- ------------------------------------------------------------
-- AI Gateway: keys, prompt logs, embedding jobs
-- ------------------------------------------------------------
create table if not exists admin.ai_provider_keys (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  provider     text not null check (provider in ('openai','anthropic','google','openrouter','lovable','custom')),
  name         text not null,
  api_key      text not null,          -- encrypted at rest by the app (or wrapper)
  base_url     text,
  created_at   timestamptz not null default now(),
  unique (project_id, provider, name)
);

create table if not exists admin.ai_prompt_logs (
  id           bigserial primary key,
  project_id   uuid not null,
  provider     text not null,
  model        text not null,
  operation    text not null,          -- chat|embedding|image|tts|stt
  input_tokens int,
  output_tokens int,
  cost_usd     numeric(12,6),
  latency_ms   int,
  status       int,
  actor_id     uuid,
  request_hash text,                    -- sha256 of request body for dedupe
  meta         jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index if not exists idx_ai_logs_project on admin.ai_prompt_logs (project_id, created_at desc);
create index if not exists idx_ai_logs_model on admin.ai_prompt_logs (project_id, model, created_at desc);

-- Embedding jobs — writes results into user-defined pgvector columns
-- managed by the existing search.ts vector_configs machinery.
create table if not exists admin.embedding_jobs (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  schema_name  text not null,
  table_name   text not null,
  row_pk       text not null,           -- primary-key value as text
  source_column text not null,
  target_column text not null,          -- vector column
  model        text not null default 'google/gemini-embedding-001',
  status       text not null default 'pending' check (status in ('pending','running','done','failed')),
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, schema_name, table_name, row_pk, target_column)
);
create index if not exists idx_embed_status on admin.embedding_jobs (project_id, status);

grant select, insert, update, delete on
  admin.ai_provider_keys, admin.ai_prompt_logs, admin.embedding_jobs to authenticated;
grant all on
  admin.ai_provider_keys, admin.ai_prompt_logs, admin.embedding_jobs to service_role;

-- ------------------------------------------------------------
-- Read replicas & routing hints
-- ------------------------------------------------------------
create table if not exists admin.read_replicas (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null,
  region        text not null,           -- e.g. eu-west-1
  label         text not null,           -- friendly name
  connection_url text not null,          -- server-side only
  weight        int not null default 100, -- load-balance weight
  enabled       boolean not null default true,
  last_health_at timestamptz,
  healthy       boolean,
  lag_bytes     bigint,
  lag_seconds   numeric(10,3),
  created_at    timestamptz not null default now(),
  unique (project_id, label)
);
create index if not exists idx_replicas_region on admin.read_replicas (project_id, region, enabled);

grant select, insert, update, delete on admin.read_replicas to authenticated;
grant all on admin.read_replicas to service_role;

-- ------------------------------------------------------------
-- Compliance: PII tagging, DSAR, erasure, retention, audit sealing
-- ------------------------------------------------------------
create table if not exists admin.pii_columns (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  schema_name  text not null,
  table_name   text not null,
  column_name  text not null,
  category     text not null check (category in ('email','phone','name','address','id_number','financial','health','ip','biometric','other')),
  masking      text not null default 'none' check (masking in ('none','hash','partial','full')),
  detected_by  text not null default 'manual' check (detected_by in ('manual','scan')),
  created_at   timestamptz not null default now(),
  unique (project_id, schema_name, table_name, column_name)
);

do $$ begin
  create type admin.dsar_status as enum ('pending','processing','ready','delivered','failed');
exception when duplicate_object then null; end $$;

create table if not exists admin.dsar_requests (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  subject_user_id uuid not null,        -- the data subject
  kind         text not null check (kind in ('export','erasure')),
  status       admin.dsar_status not null default 'pending',
  requested_by uuid,
  bundle_path  text,                    -- storage path for export
  notes        text,
  requested_at timestamptz not null default now(),
  fulfilled_at timestamptz
);
create index if not exists idx_dsar_status on admin.dsar_requests (project_id, status);

create table if not exists admin.retention_policies (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null,
  schema_name  text not null,
  table_name   text not null,
  ts_column    text not null,           -- timestamp column to age by
  keep_days    int not null check (keep_days > 0),
  strategy     text not null default 'delete' check (strategy in ('delete','anonymize')),
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  rows_last_run bigint,
  created_at   timestamptz not null default now(),
  unique (project_id, schema_name, table_name)
);

-- Immutable audit sealing (hash-chain over admin.audit_log).
create table if not exists admin.audit_seals (
  id           bigserial primary key,
  project_id   uuid,
  from_id      bigint not null,         -- audit_log.id range covered
  to_id        bigint not null,
  row_count    bigint not null,
  prev_hash    text not null,
  chain_hash   text not null,           -- sha256(prev_hash || rowhashes)
  sealed_at    timestamptz not null default now(),
  sealed_by    uuid
);
create index if not exists idx_seals_range on admin.audit_seals (project_id, to_id desc);

grant select, insert, update, delete on
  admin.pii_columns, admin.dsar_requests, admin.retention_policies, admin.audit_seals to authenticated;
grant all on
  admin.pii_columns, admin.dsar_requests, admin.retention_policies, admin.audit_seals to service_role;
