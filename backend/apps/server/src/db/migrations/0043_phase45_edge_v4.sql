-- Phase 45 — Edge Runtime v4 (deno subhosting parity).
--
-- Builds on fn_v3_* by adding:
--   * fn_v4_deployments   — multi-file bundles (entry + files map), traffic
--                           split for canary/blue-green, per-deployment env.
--   * fn_v4_secrets       — per-function secret store (encrypted at rest via
--                           app-layer AES; here we hold ciphertext).
--   * fn_v4_imports       — resolver cache for npm: / https: imports; pins
--                           versions + integrity hashes for reproducible builds.
--   * fn_v4_domains       — custom host → slug routing (parity with
--                           functions.mydomain.com).
--   * fn_v4_cron          — scheduled invocations (unix-cron expressions).
--   * fn_v4_invocations   — richer log with headers / traffic tag.

create table if not exists public.fn_v4_deployments (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  slug           text not null,
  version        int  not null,
  entry          text not null default 'index.ts',
  files          jsonb not null,          -- { "index.ts": "…code…", "lib/util.ts": "…" }
  imports        jsonb not null default '{}'::jsonb,  -- {"lodash": "npm:lodash@4.17.21"}
  env            jsonb not null default '{}'::jsonb,  -- non-secret env (public)
  timeout_ms     int not null default 5000  check (timeout_ms between 50 and 30000),
  memory_mb      int not null default 128   check (memory_mb between 32 and 1024),
  allow_hosts    text[] not null default '{}',
  traffic_pct    int not null default 100   check (traffic_pct between 0 and 100),
  active         boolean not null default true,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (workspace_id, slug, version)
);
create index if not exists ix_fn_v4_dep_active
  on public.fn_v4_deployments(workspace_id, slug) where active;

revoke all on public.fn_v4_deployments from authenticated, anon;
grant  all on public.fn_v4_deployments to service_role;
alter table public.fn_v4_deployments enable row level security;

create table if not exists public.fn_v4_secrets (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  slug           text,                    -- null => workspace-wide, else per-fn
  name           text not null,
  ciphertext     text not null,           -- AES-GCM base64 (see lib/aes.ts)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, slug, name)
);
create index if not exists ix_fn_v4_secrets_scope
  on public.fn_v4_secrets(workspace_id, slug);

revoke all on public.fn_v4_secrets from authenticated, anon;
grant  all on public.fn_v4_secrets to service_role;
alter table public.fn_v4_secrets enable row level security;

create table if not exists public.fn_v4_imports (
  id             uuid primary key default gen_random_uuid(),
  specifier      text not null,           -- e.g. "npm:lodash@4.17.21" or "https://esm.sh/…"
  resolved_url   text not null,           -- final CDN URL after resolution
  integrity      text,                    -- sha384-… subresource integrity
  size_bytes     bigint,
  cached_at      timestamptz not null default now(),
  unique (specifier)
);

revoke all on public.fn_v4_imports from authenticated, anon;
grant  all on public.fn_v4_imports to service_role;
alter table public.fn_v4_imports enable row level security;

create table if not exists public.fn_v4_domains (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  hostname       text not null unique,
  slug           text not null,
  path_prefix    text not null default '/',
  created_at     timestamptz not null default now()
);
create index if not exists ix_fn_v4_domains_ws on public.fn_v4_domains(workspace_id);

revoke all on public.fn_v4_domains from authenticated, anon;
grant  all on public.fn_v4_domains to service_role;
alter table public.fn_v4_domains enable row level security;

create table if not exists public.fn_v4_cron (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  slug           text not null,
  cron_expr      text not null,           -- '* * * * *' style, validated in app
  enabled        boolean not null default true,
  last_run_at    timestamptz,
  next_run_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (workspace_id, slug, cron_expr)
);
create index if not exists ix_fn_v4_cron_due
  on public.fn_v4_cron(enabled, next_run_at);

revoke all on public.fn_v4_cron from authenticated, anon;
grant  all on public.fn_v4_cron to service_role;
alter table public.fn_v4_cron enable row level security;

create table if not exists public.fn_v4_invocations (
  id              bigserial primary key,
  deployment_id   uuid,
  workspace_id    uuid,
  slug            text not null,
  ok              boolean not null,
  status          int,
  duration_ms     int not null,
  mem_peak_mb     int not null default 0,
  error           text,
  triggered_by    text not null default 'http',  -- http|cron|domain
  request_headers jsonb,
  started_at      timestamptz not null default now()
);
create index if not exists ix_fn_v4_inv_slug on public.fn_v4_invocations(workspace_id, slug, started_at desc);

revoke all on public.fn_v4_invocations from authenticated, anon;
grant  all on public.fn_v4_invocations to service_role;
alter table public.fn_v4_invocations enable row level security;
