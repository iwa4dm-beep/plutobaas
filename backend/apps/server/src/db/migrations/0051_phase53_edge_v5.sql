-- Phase 53 — Edge v5: WASM runtime, warm pools, per-region deploys, custom domains v2.

create table if not exists public.edge5_wasm_modules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  name text not null,
  version int not null default 1,
  sha256 text not null,
  size_bytes int not null,
  wasm bytea not null,
  entry text not null default 'handler',
  created_at timestamptz not null default now(),
  unique (workspace_id, name, version)
);

create table if not exists public.edge5_deployments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  module_id uuid not null references public.edge5_wasm_modules(id) on delete cascade,
  region text not null,
  status text not null default 'active' check (status in ('active','draining','retired')),
  min_warm int not null default 0,
  max_warm int not null default 4,
  created_at timestamptz not null default now(),
  unique (workspace_id, module_id, region)
);

create table if not exists public.edge5_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  hostname text not null unique,
  module_name text not null,
  cert_status text not null default 'pending' check (cert_status in ('pending','issued','failed')),
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.edge5_invocations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  module_id uuid not null,
  region text not null,
  cold boolean not null default false,
  duration_ms int not null,
  status int not null,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.edge5_wasm_modules to authenticated;
grant select, insert, update, delete on public.edge5_deployments to authenticated;
grant select, insert, update, delete on public.edge5_domains to authenticated;
grant select, insert on public.edge5_invocations to authenticated;
grant all on public.edge5_wasm_modules, public.edge5_deployments,
             public.edge5_domains, public.edge5_invocations to service_role;

alter table public.edge5_wasm_modules enable row level security;
alter table public.edge5_deployments enable row level security;
alter table public.edge5_domains enable row level security;
alter table public.edge5_invocations enable row level security;

create policy edge5_mod_ws on public.edge5_wasm_modules for all to authenticated
  using (workspace_id = public.current_workspace_id()) with check (workspace_id = public.current_workspace_id());
create policy edge5_dep_ws on public.edge5_deployments for all to authenticated
  using (workspace_id = public.current_workspace_id()) with check (workspace_id = public.current_workspace_id());
create policy edge5_dom_ws on public.edge5_domains for all to authenticated
  using (workspace_id = public.current_workspace_id()) with check (workspace_id = public.current_workspace_id());
create policy edge5_inv_ws on public.edge5_invocations for all to authenticated
  using (workspace_id = public.current_workspace_id()) with check (workspace_id = public.current_workspace_id());

create index if not exists edge5_dep_region_idx on public.edge5_deployments (region, status);
create index if not exists edge5_inv_recent_idx on public.edge5_invocations (workspace_id, created_at desc);
