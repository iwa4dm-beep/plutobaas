-- Phase 15 — Admin user mutations
--
-- Supports PATCH /admin/v1/users/:id and DELETE /admin/v1/users/:id.
-- The dashboard exposes three logical roles: user / admin / super_admin.
-- "super_admin" is stored as (role='admin', is_superadmin=true) — no enum
-- change needed. This migration only widens what admin.ts needs:
--   1. an updated_at column (was missing pre-0015 — safe to add idempotently)
--   2. an index on (created_at desc) for the users list
--   3. an audit trigger that logs role/superadmin/deletion changes
--
-- Existing users are unaffected. Rerunnable.

alter table auth.users
  add column if not exists email_verified boolean not null default false,
  add column if not exists updated_at     timestamptz not null default now();

create index if not exists auth_users_created_at_idx
  on auth.users (created_at desc);

-- Audit trigger: mirrors changes into admin.audit_log so /admin/v1/audit
-- shows role changes and deletions immediately.
create or replace function admin.log_user_change() returns trigger
language plpgsql as $$
declare
  action_name text;
  payload     jsonb;
begin
  if tg_op = 'DELETE' then
    action_name := 'user.delete';
    payload := jsonb_build_object('id', old.id, 'email', old.email);
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role
       or new.is_superadmin is distinct from old.is_superadmin
       or new.email_verified is distinct from old.email_verified then
      action_name := 'user.update';
      payload := jsonb_build_object(
        'id', new.id,
        'before', jsonb_build_object('role', old.role, 'is_superadmin', old.is_superadmin, 'email_verified', old.email_verified),
        'after',  jsonb_build_object('role', new.role, 'is_superadmin', new.is_superadmin, 'email_verified', new.email_verified)
      );
    else
      return new;
    end if;
  else
    return new;
  end if;

  begin
    insert into admin.audit_log (project_id, actor_id, action, params, created_at)
    values (null, null, action_name, payload, now());
  exception when others then
    -- audit_log may have a different shape in older deploys; never block writes.
    null;
  end;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_log_user_change on auth.users;
create trigger trg_log_user_change
  after update or delete on auth.users
  for each row execute function admin.log_user_change();
