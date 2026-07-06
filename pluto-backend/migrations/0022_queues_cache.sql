-- Phase 15 · 0022 — Job queues + KV cache
-- Powers /queue/v1/* and the Queues page.

create schema if not exists queue;

create table if not exists queue.queues (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  name          text not null,
  concurrency   integer not null default 1,
  retry_limit   integer not null default 3,
  retry_backoff_ms integer not null default 5000,
  paused        boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists queue.jobs (
  id            uuid primary key default gen_random_uuid(),
  queue_id      uuid not null references queue.queues(id) on delete cascade,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null check (status in ('pending','running','done','failed','dead')) default 'pending',
  attempts      integer not null default 0,
  scheduled_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists jobs_queue_status_sched_idx on queue.jobs(queue_id, status, scheduled_at);
create index if not exists jobs_status_idx on queue.jobs(status) where status in ('pending','running');

create schema if not exists cache;
create table if not exists cache.kv (
  key           text primary key,
  value         jsonb not null,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists kv_expires_idx on cache.kv(expires_at) where expires_at is not null;

grant usage on schema queue, cache to authenticated, service_role;
grant select, insert, update, delete on queue.queues, queue.jobs to authenticated;
grant all on queue.queues, queue.jobs, cache.kv to service_role;

alter table queue.queues enable row level security;
alter table queue.jobs   enable row level security;

drop policy if exists queues_read on queue.queues;
create policy queues_read on queue.queues for select to authenticated using (
  exists (select 1 from admin.workspace_members m
          where m.workspace_id = queue.queues.workspace_id and m.user_id = auth.uid())
);

drop policy if exists jobs_read on queue.jobs;
create policy jobs_read on queue.jobs for select to authenticated using (
  exists (select 1 from queue.queues q
          join admin.workspace_members m on m.workspace_id = q.workspace_id
          where q.id = queue.jobs.queue_id and m.user_id = auth.uid())
);
