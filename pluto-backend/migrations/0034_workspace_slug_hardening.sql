-- Phase A/B — subdomain hosting foundations.
--
-- `admin.workspaces.slug` already exists (UNIQUE NOT NULL, see 0001_init.sql).
-- This migration adds:
--   • Format / length CHECK constraints so a slug can safely become a DNS label.
--   • A reserved-slug guard (server-side; front-end must also enforce it).
--   • A rename-audit table so we can redirect old hostnames later.
--
-- Everything is idempotent — re-runs are safe.

begin;

-- 1. Format & length. DNS labels are 1..63 chars, but we cap at 40 to keep
--    room for `-dev` preview suffixes (Phase E). Lowercase alnum + single
--    dashes, must start and end with alnum.
alter table admin.workspaces
  drop constraint if exists workspaces_slug_format_chk;

alter table admin.workspaces
  add constraint workspaces_slug_format_chk
  check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$');

-- 2. Reserved slug list. Anything here cannot be used as a workspace slug
--    because it would collide with a first-party hostname or route.
create table if not exists admin.reserved_slugs (
  slug text primary key,
  reason text not null default 'reserved',
  created_at timestamptz not null default now()
);

grant select on admin.reserved_slugs to authenticated;
grant all on admin.reserved_slugs to service_role;

insert into admin.reserved_slugs (slug, reason) values
  ('www',        'root www redirect'),
  ('api',        'primary API host'),
  ('app',        'primary app host'),
  ('admin',      'admin console'),
  ('dashboard',  'dashboard host'),
  ('auth',       'auth service'),
  ('storage',    'storage service'),
  ('functions',  'edge functions'),
  ('realtime',   'realtime service'),
  ('cdn',        'CDN endpoint'),
  ('mail',       'mail hostname'),
  ('smtp',       'mail hostname'),
  ('status',     'status page'),
  ('docs',       'docs site'),
  ('help',       'help site'),
  ('support',    'support portal'),
  ('billing',    'billing service'),
  ('login',      'auth flow'),
  ('signup',     'auth flow'),
  ('preview',    'preview host'),
  ('sandbox',    'sandbox worker'),
  ('static',     'static assets'),
  ('assets',     'static assets'),
  ('files',      'file host'),
  ('lovable',    'brand'),
  ('vercel',     'brand'),
  ('supabase',   'brand'),
  ('pluto',      'brand')
on conflict (slug) do nothing;

-- 3. Guard function + trigger so INSERT/UPDATE cannot land on a reserved slug.
create or replace function admin.check_workspace_slug_reserved()
returns trigger
language plpgsql
security definer
set search_path = admin, public
as $$
begin
  if exists (select 1 from admin.reserved_slugs where slug = new.slug) then
    raise exception 'slug % is reserved', new.slug
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists workspaces_slug_reserved_chk on admin.workspaces;
create trigger workspaces_slug_reserved_chk
  before insert or update of slug on admin.workspaces
  for each row execute function admin.check_workspace_slug_reserved();

-- 4. Rename audit — track slug history so old subdomains can 301 to the new one.
create table if not exists admin.workspace_slug_history (
  id           bigserial primary key,
  workspace_id uuid not null references admin.workspaces(id) on delete cascade,
  old_slug     text not null,
  new_slug     text not null,
  changed_by   uuid,
  changed_at   timestamptz not null default now()
);

create index if not exists workspace_slug_history_ws_idx
  on admin.workspace_slug_history(workspace_id);
create index if not exists workspace_slug_history_old_idx
  on admin.workspace_slug_history(old_slug);

grant select on admin.workspace_slug_history to authenticated;
grant all on admin.workspace_slug_history to service_role;

create or replace function admin.log_workspace_slug_rename()
returns trigger
language plpgsql
security definer
set search_path = admin, public
as $$
begin
  if new.slug is distinct from old.slug then
    insert into admin.workspace_slug_history (workspace_id, old_slug, new_slug)
    values (new.id, old.slug, new.slug);
  end if;
  return new;
end
$$;

drop trigger if exists workspaces_slug_rename_log on admin.workspaces;
create trigger workspaces_slug_rename_log
  after update of slug on admin.workspaces
  for each row execute function admin.log_workspace_slug_rename();

commit;
