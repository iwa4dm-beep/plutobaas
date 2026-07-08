-- Phase 16 · 0032 — DBIO RBAC (per-user grants for /admin/v1/dbio/*)
--
-- Superadmins always have access. This table lets superadmins delegate
-- database import/export authority to other users without giving them the
-- full superadmin bit.
--
-- Two access levels:
--   'admin'  — full read/write (create/delete connections, run imports, exports)
--   'reader' — read-only (list connections, list jobs, download exports)

create table if not exists admin.dbio_grants (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  access      text not null check (access in ('admin','reader')),
  granted_by  uuid references auth.users(id) on delete set null,
  granted_at  timestamptz not null default now(),
  note        text
);

grant select, insert, update, delete on admin.dbio_grants to authenticated;
grant all on admin.dbio_grants to service_role;
alter table admin.dbio_grants enable row level security;

-- Only superadmins manage grants directly (routes enforce; RLS is defense-in-depth).
drop policy if exists dbio_grants_superadmin_all on admin.dbio_grants;
create policy dbio_grants_superadmin_all on admin.dbio_grants
  for all to authenticated
  using (exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin))
  with check (exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin));

-- Also allow a user to see their own grant row (so the UI can show "you have
-- dbio access" without giving away the whole list).
drop policy if exists dbio_grants_self_select on admin.dbio_grants;
create policy dbio_grants_self_select on admin.dbio_grants
  for select to authenticated
  using (user_id = auth.uid());

-- Helper: has DBIO access?
create or replace function admin.has_dbio_access(_user_id uuid, _need text default 'reader')
returns boolean
language sql
stable
security definer
set search_path = admin, auth, public
as $$
  select
    exists (select 1 from auth.users u where u.id = _user_id and u.is_superadmin)
    or exists (
      select 1 from admin.dbio_grants g
      where g.user_id = _user_id
        and (_need = 'reader' or g.access = 'admin')
    );
$$;

grant execute on function admin.has_dbio_access(uuid, text) to authenticated, service_role;
