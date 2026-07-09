-- Phase 64 — Custom-domain wildcards, per-domain primary flag, and webhook secret.
--
-- Adds:
--   • `is_wildcard`      → true for `*.tenants.example.com` claims (ACME DNS-01)
--   • `is_primary`       → workspace-scoped "this is the primary API URL"
--                          (enforced via a partial unique index)
--   • `last_error`       → free-text last verification / cert-issuance error
--   • `updated_at`       → surfaced in the dashboard & realtime broadcasts
--   • `domain_webhooks`  → one HMAC secret per workspace so external
--                          cert-issuers (Caddy on-demand, cert-manager,
--                          etc.) can POST /webhooks/v1/domains/status.

begin;

alter table public.custom_domains
  add column if not exists is_wildcard boolean not null default false,
  add column if not exists is_primary  boolean not null default false,
  add column if not exists last_error  text,
  add column if not exists updated_at  timestamptz not null default now();

-- Only one primary domain per workspace.
drop index if exists custom_domains_primary_unique;
create unique index custom_domains_primary_unique
  on public.custom_domains (workspace_id)
  where is_primary;

-- Bump updated_at on every write so realtime consumers can dedupe.
create or replace function public._touch_custom_domains() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists custom_domains_touch on public.custom_domains;
create trigger custom_domains_touch
  before update on public.custom_domains
  for each row execute function public._touch_custom_domains();

-- Backfill wildcard flag from existing hostnames.
update public.custom_domains
   set is_wildcard = true
 where hostname like '*.%'
   and is_wildcard = false;

-- Per-workspace webhook secret used by the backend to sign realtime status
-- notifications and to authenticate inbound cert-issuer webhooks.
create table if not exists public.domain_webhooks (
  workspace_id uuid primary key,
  secret       text not null default encode(gen_random_bytes(32),'hex'),
  created_at   timestamptz not null default now(),
  rotated_at   timestamptz
);

grant select, insert, update on public.domain_webhooks to authenticated;
grant all on public.domain_webhooks to service_role;

alter table public.domain_webhooks enable row level security;

drop policy if exists domain_webhooks_ws on public.domain_webhooks;
create policy domain_webhooks_ws on public.domain_webhooks
  for all to authenticated
  using (workspace_id::text = current_setting('request.workspace_id', true))
  with check (workspace_id::text = current_setting('request.workspace_id', true));

commit;
