-- Phase 41 — Auth completeness.
--
-- Adds the pieces the Supabase-parity plan called out:
--   • Magic-link (passwordless email login) tokens
--   • Anonymous sign-in flag on public.users + link-to-permanent
--   • Auth hooks (before_signin / after_signup / …) — pluggable webhooks
--   • Per-endpoint rate-limit policies (admin-configurable)
--
-- Everything below is service_role only. Hook dispatch + magic-link
-- endpoints go through Fastify preHandlers.

-- ---- Magic-link (passwordless) ----------------------------------------
create table if not exists public.magic_link_tokens (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  user_id       uuid references public.users(id) on delete cascade,
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now(),
  requested_ip  inet
);
create index if not exists ix_mlt_email      on public.magic_link_tokens(email);
create index if not exists ix_mlt_expires_at on public.magic_link_tokens(expires_at) where used_at is null;
revoke all on public.magic_link_tokens from public, anon, authenticated;
grant  all on public.magic_link_tokens to service_role;
alter  table public.magic_link_tokens enable row level security;

-- ---- Anonymous users ---------------------------------------------------
alter table public.users
  add column if not exists is_anonymous boolean not null default false;
create index if not exists ix_users_anon on public.users(is_anonymous) where is_anonymous;

-- ---- Auth hooks (pluggable webhooks) ----------------------------------
create table if not exists public.auth_hooks (
  id            uuid primary key default gen_random_uuid(),
  event         text not null check (event in (
                  'before_signin','after_signin',
                  'before_signup','after_signup',
                  'before_password_reset','after_password_reset',
                  'after_magic_link','after_anonymous_signin')),
  target_url    text not null,
  secret        text,                 -- HMAC-SHA256 signing key
  active        boolean not null default true,
  timeout_ms    int not null default 3000,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ix_auth_hooks_event on public.auth_hooks(event) where active;

create table if not exists public.auth_hook_deliveries (
  id            bigserial primary key,
  hook_id       uuid references public.auth_hooks(id) on delete cascade,
  event         text not null,
  status        int,
  ok            boolean not null,
  duration_ms   int,
  error         text,
  request_body  jsonb,
  response_body text,
  sent_at       timestamptz not null default now()
);
create index if not exists ix_hd_hook on public.auth_hook_deliveries(hook_id, sent_at desc);

revoke all on public.auth_hooks, public.auth_hook_deliveries from public, anon, authenticated;
grant  all on public.auth_hooks, public.auth_hook_deliveries to service_role;
alter  table public.auth_hooks           enable row level security;
alter  table public.auth_hook_deliveries enable row level security;

-- ---- Per-endpoint rate-limit policies ---------------------------------
create table if not exists public.rate_limit_policies (
  id            uuid primary key default gen_random_uuid(),
  route_pattern text not null,           -- glob, e.g. /auth/v1/sign-in or /rest/v1/*
  scope         text not null default 'ip' check (scope in ('ip','user','token','ip_email')),
  window_sec    int  not null default 60,
  max_requests  int  not null default 60,
  burst         int  not null default 0,
  active        boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (route_pattern, scope)
);
create index if not exists ix_rlp_active on public.rate_limit_policies(active);

revoke all on public.rate_limit_policies from public, anon, authenticated;
grant  select on public.rate_limit_policies to authenticated;
grant  all    on public.rate_limit_policies to service_role;
alter  table public.rate_limit_policies enable row level security;

drop policy if exists rlp_read on public.rate_limit_policies;
create policy rlp_read on public.rate_limit_policies for select to authenticated using (true);

-- Seed safe defaults (Supabase-style leaky bucket per-IP on auth surfaces).
insert into public.rate_limit_policies(route_pattern, scope, window_sec, max_requests, notes) values
  ('/auth/v1/sign-in',       'ip_email', 60,  10, 'Anti brute-force on login'),
  ('/auth/v1/sign-up',       'ip',       60,  5,  'Slow spam signups'),
  ('/auth/v1/recover',       'ip',       300, 5,  'Password reset requests'),
  ('/auth/v1/magic-link',    'ip',       300, 5,  'Magic link requests'),
  ('/auth/v1/otp/send',      'ip',       300, 5,  'SMS OTP requests'),
  ('/rest/v1/*',             'token',    60,  600, 'Data API per-token'),
  ('/functions/v1/*',        'token',    60,  300, 'Edge invocations per-token'),
  ('/graphql/v1',            'token',    60,  300, 'GraphQL per-token')
on conflict (route_pattern, scope) do nothing;
