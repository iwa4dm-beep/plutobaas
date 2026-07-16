-- 0036_custom_domain_reconciler.sql
-- Phase D — Custom Domain Auto-Wire
--
-- Adds reconciliation columns to enterprise.custom_domains so a VPS-side
-- reconciler daemon can drive nginx + TLS state and report back.
--
-- Schema-safe: only runs if the table already exists; every ALTER uses
-- IF NOT EXISTS. Nothing here is destructive.

do $mig$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema='enterprise' and table_name='custom_domains'
  ) then
    raise notice 'enterprise.custom_domains not present — skipping 0036';
    return;
  end if;

  -- Target project/workspace binding (which site root nginx should serve).
  execute 'alter table enterprise.custom_domains
             add column if not exists target_workspace_id uuid';
  execute 'alter table enterprise.custom_domains
             add column if not exists target_slug citext';

  -- Reconciler state machine.
  --   pending   → verified row waiting for the reconciler
  --   issuing   → certbot in flight
  --   live      → nginx site + cert active
  --   failed    → last_error populated, will retry with backoff
  --   removing  → deletion requested, awaiting nginx cleanup
  execute $$alter table enterprise.custom_domains
             add column if not exists nginx_state text
             not null default 'pending'
             check (nginx_state in ('pending','issuing','live','failed','removing'))$$;

  execute 'alter table enterprise.custom_domains
             add column if not exists last_reconciled_at timestamptz';
  execute 'alter table enterprise.custom_domains
             add column if not exists cert_expires_at   timestamptz';
  execute 'alter table enterprise.custom_domains
             add column if not exists cert_last_error   text';
  execute 'alter table enterprise.custom_domains
             add column if not exists reconcile_attempts integer not null default 0';
  execute 'alter table enterprise.custom_domains
             add column if not exists next_retry_at     timestamptz';
end
$mig$;

-- Index used by the reconciler picker query. Wrapped in DO to survive when
-- the table doesn't exist yet in dev environments.
do $idx$
begin
  if exists (select 1 from information_schema.tables
             where table_schema='enterprise' and table_name='custom_domains') then
    execute 'create index if not exists custom_domains_reconcile_idx
             on enterprise.custom_domains (nginx_state, next_retry_at nulls first)';
  end if;
end
$idx$;
