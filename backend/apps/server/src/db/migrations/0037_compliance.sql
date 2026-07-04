-- Phase 40 — SOC2 artifacts: right-to-delete + data-residency ledger.

create table if not exists public.gdpr_delete_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  requested_at   timestamptz not null default now(),
  scheduled_for  timestamptz not null default (now() + interval '30 days'),
  status         text not null default 'pending', -- pending | processing | done | cancelled
  completed_at   timestamptz,
  notes          text
);
create index if not exists ix_gdpr_status on public.gdpr_delete_requests(status, scheduled_for);

create table if not exists public.data_residency (
  workspace_id   uuid primary key,
  region         text not null default 'us-east-1',
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);

create table if not exists public.kms_key_versions (
  id             uuid primary key default gen_random_uuid(),
  purpose        text not null,          -- 'session' | 'jwt' | 'encryption'
  version        int  not null,
  algo           text not null,          -- 'aes-256-gcm' | 'ed25519' | 'hs256'
  public_jwk     jsonb,                  -- non-null for asymmetric
  wrapped_dek    text,                   -- base64(kms-wrapped data key)
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  rotated_at     timestamptz,
  unique (purpose, version)
);

revoke all on public.gdpr_delete_requests, public.data_residency, public.kms_key_versions
  from public, anon, authenticated;
grant  all on public.gdpr_delete_requests, public.data_residency, public.kms_key_versions
  to service_role;
