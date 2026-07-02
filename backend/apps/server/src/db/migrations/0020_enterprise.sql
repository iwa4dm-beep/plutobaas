-- Phase 20 — Enterprise & Multi-region
-- IP allow/deny lists per workspace, custom-domain claims (HTTPS via
-- Caddy on-demand TLS), region hints for read-replica routing, and a
-- lightweight status/incidents table for a public status page.

create table if not exists public.ip_access_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  cidr         cidr not null,
  action       text not null check (action in ('allow','deny')),
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ip_rules_ws on public.ip_access_rules (workspace_id);
grant select, insert, update, delete on public.ip_access_rules to authenticated;
grant all on public.ip_access_rules to service_role;
alter table public.ip_access_rules enable row level security;
create policy ip_rules_ws on public.ip_access_rules
  for all to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true))
  with check (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.custom_domains (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  hostname     text not null unique,
  verified     boolean not null default false,
  verify_token text not null default encode(gen_random_bytes(16),'hex'),
  cert_status  text not null default 'pending',       -- pending|issued|failed
  created_at   timestamptz not null default now(),
  verified_at  timestamptz
);
grant select, insert, update, delete on public.custom_domains to authenticated;
grant all on public.custom_domains to service_role;
alter table public.custom_domains enable row level security;
create policy domains_ws on public.custom_domains
  for all to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true))
  with check (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.region_routing (
  workspace_id     uuid primary key,
  primary_region   text not null default 'auto',
  read_regions     text[] not null default '{}'::text[],
  pin_writes       boolean not null default true,
  updated_at       timestamptz not null default now()
);
grant select, insert, update on public.region_routing to authenticated;
grant all on public.region_routing to service_role;
alter table public.region_routing enable row level security;
create policy region_ws on public.region_routing
  for all to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true))
  with check (workspace_id::text = current_setting('request.workspace_id', true));

create table if not exists public.status_components (
  id      uuid primary key default gen_random_uuid(),
  name    text not null unique,        -- api, auth, storage, realtime, db, ai
  status  text not null default 'operational' check (status in ('operational','degraded','partial_outage','major_outage','maintenance')),
  updated_at timestamptz not null default now()
);
grant select on public.status_components to anon, authenticated;
grant all    on public.status_components to service_role;
alter table public.status_components enable row level security;
create policy status_public_read on public.status_components
  for select to anon, authenticated using (true);

create table if not exists public.status_incidents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text not null default '',
  severity     text not null default 'minor' check (severity in ('minor','major','critical','maintenance')),
  component_id uuid references public.status_components(id) on delete set null,
  started_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
grant select on public.status_incidents to anon, authenticated;
grant all    on public.status_incidents to service_role;
alter table public.status_incidents enable row level security;
create policy incidents_public_read on public.status_incidents
  for select to anon, authenticated using (true);

-- Seed the six core components so the status page is never empty.
insert into public.status_components (name, status) values
  ('api','operational'),('auth','operational'),('storage','operational'),
  ('realtime','operational'),('database','operational'),('ai','operational')
  on conflict (name) do nothing;
