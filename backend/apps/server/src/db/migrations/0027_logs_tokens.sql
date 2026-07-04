-- Phase 27 — Logs Explorer retention + Phase 28 — Workspace API tokens

-- 27a: retention policy per workspace (days). Nulls / missing = keep 30d.
create table if not exists public.log_retention (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  keep_days int not null default 30 check (keep_days between 1 and 365),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.log_retention to authenticated;
grant all on public.log_retention to service_role;
alter table public.log_retention enable row level security;
create policy log_retention_service_only on public.log_retention for all to authenticated using (false) with check (false);

-- 27b: helpful index for the logs explorer filters.
create index if not exists api_logs_ts_source_level_idx on public.api_logs (ts desc, source, level);
create index if not exists api_logs_message_trgm_idx on public.api_logs using gin (message gin_trgm_ops)
  where message is not null;

-- 28: workspace-scoped API tokens with granular scopes.
-- Token format at issue time: `plt_<prefix>_<secret>` — only sha256 is stored.
create table if not exists public.workspace_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  prefix text not null,               -- first 8 chars, shown in listings
  token_hash text not null unique,    -- sha256 of full plaintext
  scopes text[] not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create index if not exists workspace_tokens_ws_idx on public.workspace_tokens (workspace_id, created_at desc);
grant select, insert, update, delete on public.workspace_tokens to authenticated;
grant all on public.workspace_tokens to service_role;
alter table public.workspace_tokens enable row level security;
create policy workspace_tokens_service_only on public.workspace_tokens for all to authenticated using (false) with check (false);
