-- Phase 18 — Observability & Compliance
-- Runtime metrics samples, tracing spans, and GDPR export/erasure requests.

create table if not exists public.metrics_samples (
  id           bigserial primary key,
  workspace_id uuid,
  metric       text not null,          -- e.g. http.request, sql.duration
  value        double precision not null,
  labels       jsonb not null default '{}'::jsonb,
  observed_at  timestamptz not null default now()
);
create index if not exists idx_metrics_metric_time
  on public.metrics_samples (metric, observed_at desc);
create index if not exists idx_metrics_ws_time
  on public.metrics_samples (workspace_id, observed_at desc);
grant select on public.metrics_samples to authenticated;
grant all    on public.metrics_samples to service_role;
grant insert on public.metrics_samples to pluto_jobs;
alter table public.metrics_samples enable row level security;
create policy metrics_ws_read on public.metrics_samples
  for select to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.trace_spans (
  span_id      uuid primary key default gen_random_uuid(),
  trace_id     uuid not null,
  parent_id    uuid,
  workspace_id uuid,
  name         text not null,
  kind         text not null default 'internal',
  attributes   jsonb not null default '{}'::jsonb,
  started_at   timestamptz not null,
  ended_at     timestamptz,
  duration_ms  int
);
create index if not exists idx_trace_spans_trace on public.trace_spans (trace_id);
create index if not exists idx_trace_spans_time  on public.trace_spans (started_at desc);
grant select on public.trace_spans to authenticated;
grant all    on public.trace_spans to service_role;
grant insert on public.trace_spans to pluto_jobs;
alter table public.trace_spans enable row level security;

create table if not exists public.gdpr_requests (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  subject_id   uuid not null,           -- auth user id
  kind         text not null check (kind in ('export','erasure')),
  status       text not null default 'pending'
                 check (status in ('pending','running','completed','failed','cancelled')),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  artifact_key text,                    -- storage object for export bundle
  notes        text
);
create index if not exists idx_gdpr_subject on public.gdpr_requests (subject_id, requested_at desc);
grant select on public.gdpr_requests to authenticated;
grant all    on public.gdpr_requests to service_role;
alter table public.gdpr_requests enable row level security;
create policy gdpr_own_read on public.gdpr_requests
  for select to authenticated
  using (subject_id::text = current_setting('request.jwt.claims', true)::jsonb->>'sub');
