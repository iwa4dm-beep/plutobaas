-- Phase 29 — per-alert webhook delivery attempts and retry tracking.

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references public.workspace_webhooks(id) on delete cascade,
  alert_id uuid references public.quota_alerts(id) on delete set null,
  event text not null,                     -- e.g. 'quota.alert'
  attempt int not null default 1,
  status_code int,                         -- HTTP status returned, null on network error
  response_time_ms int,
  error text,                              -- last error message (network / non-2xx body)
  payload_hash text not null,              -- sha256(body) so retries reuse the exact payload
  payload jsonb not null,                  -- kept small so we can redeliver from the DB
  delivered_at timestamptz not null default now(),
  next_retry_at timestamptz,               -- null when done or exhausted
  succeeded boolean not null default false
);
create index if not exists webhook_deliveries_hook_idx
  on public.webhook_deliveries (webhook_id, delivered_at desc);
create index if not exists webhook_deliveries_retry_idx
  on public.webhook_deliveries (next_retry_at) where next_retry_at is not null and succeeded = false;

grant select, insert, update, delete on public.webhook_deliveries to authenticated;
grant all on public.webhook_deliveries to service_role;
alter table public.webhook_deliveries enable row level security;
create policy webhook_deliveries_service_only on public.webhook_deliveries
  for all to authenticated using (false) with check (false);
