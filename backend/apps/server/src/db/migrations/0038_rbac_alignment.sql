-- Phase 40 — RBAC alignment with dashboard.
--
-- The dashboard exposes four roles: owner, admin, developer, viewer.
-- The original 0006 migration only allowed owner/admin/member/viewer, so
-- the RBAC UI's role selector could never persist "developer". Widen the
-- CHECK constraint and migrate any existing `member` rows to
-- `developer` (semantic equivalent — "can edit data + code, not billing").
--
-- Also seed a durable role→capability matrix so /admin/v1/rbac/permissions
-- can return a stable contract instead of hard-coding it in the app.

do $$
begin
  begin
    alter table public.workspace_members
      drop constraint if exists workspace_members_role_check;
  exception when others then null;
  end;
end $$;

update public.workspace_members set role = 'developer' where role = 'member';

alter table public.workspace_members
  add constraint workspace_members_role_check
    check (role in ('owner','admin','developer','viewer'));

create table if not exists public.rbac_permissions (
  role         text not null check (role in ('owner','admin','developer','viewer')),
  capability   text not null,
  primary key (role, capability)
);

grant select on public.rbac_permissions to authenticated;
grant all    on public.rbac_permissions to service_role;
alter table public.rbac_permissions enable row level security;

drop policy if exists rbac_permissions_read on public.rbac_permissions;
create policy rbac_permissions_read on public.rbac_permissions
  for select to authenticated using (true);

-- The matrix. Kept intentionally small — additional capabilities are
-- inferred at request time via has_role() checks in downstream modules.
insert into public.rbac_permissions(role, capability) values
  ('owner',     'workspace.delete'),
  ('owner',     'billing.manage'),
  ('owner',     'members.manage'),
  ('owner',     'keys.rotate'),
  ('owner',     'data.write'),
  ('owner',     'data.read'),
  ('owner',     'schema.write'),
  ('owner',     'functions.deploy'),
  ('admin',     'members.manage'),
  ('admin',     'keys.rotate'),
  ('admin',     'data.write'),
  ('admin',     'data.read'),
  ('admin',     'schema.write'),
  ('admin',     'functions.deploy'),
  ('developer', 'data.write'),
  ('developer', 'data.read'),
  ('developer', 'schema.write'),
  ('developer', 'functions.deploy'),
  ('viewer',    'data.read')
on conflict do nothing;
