-- Phase 5: OAuth accounts, edge functions, realtime broadcast trigger.

create table if not exists public.oauth_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null check (provider in ('google','github')),
  provider_user_id text not null,
  created_at timestamptz not null default now(),
  unique (provider, provider_user_id)
);

create table if not exists public.edge_functions (
  slug text primary key,
  code text not null,
  runtime text not null default 'js' check (runtime in ('js')),
  timeout_ms int not null default 5000,
  public boolean not null default false,
  created_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Realtime: NOTIFY on any row change; the WS layer subscribes with LISTEN.
create or replace function public.pluto_notify_change() returns trigger
language plpgsql as $$
declare
  payload jsonb;
  row_data jsonb;
begin
  if (tg_op = 'DELETE') then row_data := to_jsonb(old);
  else row_data := to_jsonb(new);
  end if;
  payload := jsonb_build_object(
    'schema', tg_table_schema,
    'table',  tg_table_name,
    'type',   tg_op,
    'record', row_data
  );
  perform pg_notify('pluto_changes', payload::text);
  return coalesce(new, old);
end;
$$;

-- Convenience: attach the trigger to a table.
create or replace function public.pluto_enable_realtime(_table regclass) returns void
language plpgsql as $$
declare trg text := 'pluto_notify_' || replace(_table::text, '.', '_');
begin
  execute format('drop trigger if exists %I on %s', trg, _table);
  execute format(
    'create trigger %I after insert or update or delete on %s for each row execute function public.pluto_notify_change()',
    trg, _table
  );
end;
$$;
