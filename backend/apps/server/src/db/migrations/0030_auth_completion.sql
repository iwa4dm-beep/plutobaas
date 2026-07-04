-- Phase 31 — Auth completion: password reset, email confirmation, phone OTP.
--
-- Follows the RLS/GRANT lockdown pattern (docs/security/core-tables-rls.md):
-- all new tables are service_role only. Users never touch these directly;
-- auth endpoints mediate every read/write with a Fastify preHandler.

-- ---- Password reset ----------------------------------------------------
create table if not exists public.password_reset_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now(),
  requested_ip  inet
);
create index if not exists ix_prt_user       on public.password_reset_tokens(user_id);
create index if not exists ix_prt_expires_at on public.password_reset_tokens(expires_at) where used_at is null;

revoke all on public.password_reset_tokens from authenticated, anon;
grant all  on public.password_reset_tokens to service_role;
alter table public.password_reset_tokens enable row level security;
-- No policies — service_role bypasses RLS; nothing else may read.

-- ---- Email confirmation ------------------------------------------------
alter table public.users
  add column if not exists email_confirmed_at      timestamptz,
  add column if not exists email_confirm_token_hash text,
  add column if not exists email_confirm_sent_at   timestamptz;
create unique index if not exists ux_users_email_confirm_token
  on public.users(email_confirm_token_hash) where email_confirm_token_hash is not null;

-- Backfill: existing verified accounts get a confirmation timestamp so
-- optional requireEmailConfirmed middleware doesn't lock them out.
update public.users set email_confirmed_at = coalesce(email_confirmed_at, created_at)
 where email_verified is true and email_confirmed_at is null;

-- ---- Phone / SMS OTP ---------------------------------------------------
alter table public.users
  add column if not exists phone               text,
  add column if not exists phone_confirmed_at  timestamptz;
create unique index if not exists ux_users_phone on public.users(phone) where phone is not null;

create table if not exists public.phone_otp_codes (
  id           uuid primary key default gen_random_uuid(),
  phone        text not null,
  code_hash    text not null,
  channel      text not null default 'sms' check (channel in ('sms','whatsapp')),
  purpose      text not null default 'signin' check (purpose in ('signin','verify')),
  expires_at   timestamptz not null,
  attempts     integer not null default 0,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  requested_ip inet
);
create index if not exists ix_otp_phone      on public.phone_otp_codes(phone);
create index if not exists ix_otp_expires_at on public.phone_otp_codes(expires_at) where consumed_at is null;

revoke all on public.phone_otp_codes from authenticated, anon;
grant all  on public.phone_otp_codes to service_role;
alter table public.phone_otp_codes enable row level security;
