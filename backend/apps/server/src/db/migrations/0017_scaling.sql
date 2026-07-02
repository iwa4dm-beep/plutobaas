-- Phase 17 — Scaling & Performance
-- Job queues (durable, retry, DLQ), cache entries (KV with TTL),
-- and rate-limit policies (per-route/workspace).

create table if not exists public.queue_jobs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  queue        text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending'
                 check (status in ('pending','running','done','failed','dead')),
  attempts     int  not null default 0,
  max_attempts int  not null default 5,
  run_at       timestamptz not null default now(),
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  result       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_queue_jobs_dispatch
  on public.queue_jobs (queue, status, run_at)
  where status in ('pending','running');
create index if not exists idx_queue_jobs_ws
  on public.queue_jobs (workspace_id, created_at desc);

grant select on public.queue_jobs to authenticated;
grant all    on public.queue_jobs to service_role;
grant select, insert, update on public.queue_jobs to pluto_jobs;

alter table public.queue_jobs enable row level security;
create policy queue_jobs_ws_read on public.queue_jobs
  for select to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.cache_entries (
  workspace_id uuid,
  key          text not null,
  value        jsonb not null,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, key)
);
create index if not exists idx_cache_expiry on public.cache_entries (expires_at)
  where expires_at is not null;
grant select on public.cache_entries to authenticated;
grant all    on public.cache_entries to service_role;
alter table public.cache_entries enable row level security;
create policy cache_ws_read on public.cache_entries
  for select to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.rate_limit_policies (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  route        text not null,          -- e.g. "/auth/v1/token" or "*"
  scope        text not null default 'ip' check (scope in ('ip','user','workspace','key')),
  max_hits     int  not null,
  window_sec   int  not null,
  action       text not null default 'block' check (action in ('block','shadow')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, route, scope)
);
grant select on public.rate_limit_policies to authenticated;
grant all    on public.rate_limit_policies to service_role;
alter table public.rate_limit_policies enable row level security;
create policy rl_pol_ws_read on public.rate_limit_policies
  for select to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true));
