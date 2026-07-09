-- Phase 65 — Per-workspace domain-admin permission.
--
-- Grants a subset of users the ability to manage custom domains
-- (add / verify / make-primary / remove / rotate webhook secret)
-- without giving them full workspace-admin privileges.
--
-- Workspace owners/admins (in workspace_members) always retain the
-- ability to manage domains; this table only extends the set.
begin;

create table if not exists public.workspace_domain_admins (
  workspace_id uuid not null,
  user_id      uuid not null,
  granted_by   uuid,
  granted_at   timestamptz not null default now(),
  note         text,
  primary key (workspace_id, user_id)
);

create index if not exists workspace_domain_admins_user_idx
  on public.workspace_domain_admins (user_id);

grant select on public.workspace_domain_admins to authenticated;
grant all on public.workspace_domain_admins to service_role;

alter table public.workspace_domain_admins enable row level security;

drop policy if exists workspace_domain_admins_read on public.workspace_domain_admins;
create policy workspace_domain_admins_read on public.workspace_domain_admins
  for select to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true));

commit;
