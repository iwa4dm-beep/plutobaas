-- Phase 15 · 0026 — Realtime system channels + broadcast log
-- Registers the two admin-only system channels used by the dashboard
-- WebSocket subscriptions: system:audit and system:migrations.

create table if not exists public.realtime_system_channels (
  name          text primary key,
  description   text not null,
  admin_only    boolean not null default true,
  created_at    timestamptz not null default now()
);

grant select on public.realtime_system_channels to authenticated;
grant all    on public.realtime_system_channels to service_role;
alter table public.realtime_system_channels enable row level security;

drop policy if exists rsc_read on public.realtime_system_channels;
create policy rsc_read on public.realtime_system_channels for select to authenticated using (
  not admin_only
  or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
);

insert into public.realtime_system_channels (name, description, admin_only) values
  ('system:audit',      'Audit events stream (admin.audit_log inserts)',       true),
  ('system:migrations', 'Migration ledger updates (_pluto_migrations inserts)',true),
  ('system:health',     'Health / status changes (livez / readyz)',            true)
on conflict (name) do nothing;

-- Broadcast log — a lightweight fanout table the realtime hub can tail.
create table if not exists public.realtime_broadcasts (
  id            bigserial primary key,
  channel       text not null,
  event         text not null,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists rt_broadcasts_channel_id_idx
  on public.realtime_broadcasts(channel, id desc);

grant select, insert on public.realtime_broadcasts to authenticated;
grant all on public.realtime_broadcasts to service_role;
grant usage, select on sequence public.realtime_broadcasts_id_seq to authenticated, service_role;

alter table public.realtime_broadcasts enable row level security;
drop policy if exists rt_broadcasts_read on public.realtime_broadcasts;
create policy rt_broadcasts_read on public.realtime_broadcasts for select to authenticated using (
  channel not like 'system:%'
  or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
);

-- Trigger: mirror new audit_log rows onto the system:audit broadcast.
create or replace function public.fanout_audit_to_realtime() returns trigger
language plpgsql as $$
begin
  insert into public.realtime_broadcasts (channel, event, payload)
  values ('system:audit', 'insert', to_jsonb(new));
  perform pg_notify('system:audit', to_jsonb(new)::text);
  return new;
end $$;

do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'admin' and table_name = 'audit_log') then
    drop trigger if exists trg_fanout_audit on admin.audit_log;
    create trigger trg_fanout_audit after insert on admin.audit_log
      for each row execute function public.fanout_audit_to_realtime();
  end if;
end $$;

-- Trigger: mirror new applied migrations.
create or replace function public.fanout_migration_to_realtime() returns trigger
language plpgsql as $$
begin
  insert into public.realtime_broadcasts (channel, event, payload)
  values ('system:migrations', 'applied', to_jsonb(new));
  perform pg_notify('system:migrations', to_jsonb(new)::text);
  return new;
end $$;

drop trigger if exists trg_fanout_migration on public._pluto_migrations;
create trigger trg_fanout_migration after insert on public._pluto_migrations
  for each row execute function public.fanout_migration_to_realtime();
