-- Phase 26 — Quota alerts + workspace webhooks.

create table if not exists public.quota_alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  metric text not null,
  pct numeric not null,
  used numeric not null,
  hard_limit numeric,
  triggered_at timestamptz not null default now(),
  notified boolean not null default false,
  resolved_at timestamptz
);
create index if not exists quota_alerts_ws_idx on public.quota_alerts(workspace_id, triggered_at desc);

grant select, insert, update, delete on public.quota_alerts to authenticated;
grant all on public.quota_alerts to service_role;
alter table public.quota_alerts enable row level security;
create policy if not exists quota_alerts_ws on public.quota_alerts
  for all to authenticated using (true) with check (true);

create table if not exists public.workspace_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  url text not null,
  secret text,
  events text[] not null default array['quota.alert'],
  active boolean not null default true,
  last_status int,
  last_error text,
  last_delivered_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.workspace_webhooks to authenticated;
grant all on public.workspace_webhooks to service_role;
alter table public.workspace_webhooks enable row level security;
create policy if not exists workspace_webhooks_ws on public.workspace_webhooks
  for all to authenticated using (true) with check (true);
