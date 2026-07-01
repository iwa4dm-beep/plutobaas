-- Phase 8b: RLS hardening.
--
-- The initial migrations created several tables without enabling
-- row-level security. This closes those gaps so the static regression
-- check (`scripts/check-rls.mjs`) passes and so accidental grants can
-- never bypass tenant isolation.
--
-- Policy strategy per table:
--   users, refresh_tokens, api_logs, oauth_accounts, schema_migrations
--       → server-only (`using (false)`). App code accesses these via
--         the service_role which bypasses RLS by convention.
--   buckets, objects, edge_functions
--       → already have workspace-scoped policies from 0006 / earlier;
--         we just need to *enable* RLS here for them to take effect.

alter table public.users             enable row level security;
alter table public.refresh_tokens    enable row level security;
alter table public.buckets           enable row level security;
alter table public.objects           enable row level security;
alter table public.api_logs          enable row level security;
alter table public.oauth_accounts    enable row level security;
alter table public.edge_functions    enable row level security;
alter table public.schema_migrations enable row level security;

-- Locked-down policies (deny all) for the server-only tables. The
-- service_role bypasses RLS so backend code is unaffected; authenticated
-- callers now cannot read/write these tables even if a stray grant
-- appears.
drop policy if exists users_service_only             on public.users;
create policy users_service_only              on public.users             for all to authenticated using (false) with check (false);
drop policy if exists refresh_tokens_service_only    on public.refresh_tokens;
create policy refresh_tokens_service_only     on public.refresh_tokens    for all to authenticated using (false) with check (false);
drop policy if exists api_logs_service_only          on public.api_logs;
create policy api_logs_service_only           on public.api_logs          for all to authenticated using (false) with check (false);
drop policy if exists oauth_accounts_service_only    on public.oauth_accounts;
create policy oauth_accounts_service_only     on public.oauth_accounts    for all to authenticated using (false) with check (false);
drop policy if exists schema_migrations_service_only on public.schema_migrations;
create policy schema_migrations_service_only  on public.schema_migrations for all to authenticated using (false) with check (false);

-- edge_functions is workspace-scoped; add the missing workspace policy.
drop policy if exists edge_functions_workspace_scope on public.edge_functions;
create policy edge_functions_workspace_scope on public.edge_functions
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- +migrate down
drop policy if exists edge_functions_workspace_scope on public.edge_functions;
drop policy if exists schema_migrations_service_only on public.schema_migrations;
drop policy if exists oauth_accounts_service_only    on public.oauth_accounts;
drop policy if exists api_logs_service_only          on public.api_logs;
drop policy if exists refresh_tokens_service_only    on public.refresh_tokens;
drop policy if exists users_service_only             on public.users;
alter table public.schema_migrations disable row level security;
alter table public.edge_functions    disable row level security;
alter table public.oauth_accounts    disable row level security;
alter table public.api_logs          disable row level security;
alter table public.objects           disable row level security;
alter table public.buckets           disable row level security;
alter table public.refresh_tokens    disable row level security;
alter table public.users             disable row level security;
