-- 0010: brute-force protection + workspace API key rotation w/ grace period.
--
-- Two additions:
--   1. public.auth_attempts — one row per sign-in / refresh attempt
--      (ip, email, kind, outcome). Used to compute lockout windows and
--      drives the dashboard's "failed logins" view.
--   2. Extra columns on public.workspace_api_keys:
--        - status: 'active' | 'rotating' | 'revoked'
--        - rotated_from_id / rotated_to_id: link a key to its
--          predecessor/successor across a rotation.
--        - grace_expires_at: while non-null AND in the future, a
--          'rotating' predecessor key is still accepted alongside its
--          successor — clients get a window to swap credentials.

create table if not exists public.auth_attempts (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  kind         text not null check (kind in ('sign_in','refresh','sign_up')),
  email        text,
  ip           inet,
  user_agent   text,
  outcome      text not null check (outcome in ('ok','bad_credentials','locked','invalid_token','rate_limited','error'))
);
create index if not exists auth_attempts_email_ts_idx on public.auth_attempts (lower(email), ts desc);
create index if not exists auth_attempts_ip_ts_idx    on public.auth_attempts (ip, ts desc);

grant select on public.auth_attempts to authenticated;
grant all    on public.auth_attempts to service_role;
alter table public.auth_attempts enable row level security;
drop policy if exists auth_attempts_service_only on public.auth_attempts;
create policy auth_attempts_service_only on public.auth_attempts
  for all to authenticated using (false) with check (false);

-- Key rotation columns.
alter table public.workspace_api_keys
  add column if not exists status text not null default 'active'
    check (status in ('active','rotating','revoked'));
alter table public.workspace_api_keys
  add column if not exists rotated_from_id uuid references public.workspace_api_keys(id) on delete set null;
alter table public.workspace_api_keys
  add column if not exists rotated_to_id   uuid references public.workspace_api_keys(id) on delete set null;
alter table public.workspace_api_keys
  add column if not exists grace_expires_at timestamptz;

-- Backfill status for any pre-existing rows.
update public.workspace_api_keys
   set status = case when revoked_at is not null then 'revoked' else 'active' end
 where status = 'active' and revoked_at is not null;

create index if not exists workspace_api_keys_grace_idx
  on public.workspace_api_keys (status, grace_expires_at)
  where status = 'rotating';
