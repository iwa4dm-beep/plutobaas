-- Migration 0001 — notes table + RLS
-- Schema version: 1
-- Idempotent. Applied automatically by setup.sql (and docker-compose starter-schema).

create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists notes_user_id_created_at_idx
  on public.notes (user_id, created_at desc);

grant select, insert, update, delete on public.notes to authenticated;
grant all on public.notes to service_role;

alter table public.notes enable row level security;

drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own" on public.notes for select
  to authenticated using (user_id = auth.uid());

drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own" on public.notes for insert
  to authenticated with check (user_id = auth.uid());

drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own" on public.notes for update
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own" on public.notes for delete
  to authenticated using (user_id = auth.uid());

create or replace function public.notes_set_user_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null then new.user_id := auth.uid(); end if;
  return new;
end;
$$;

drop trigger if exists notes_set_user_id on public.notes;
create trigger notes_set_user_id before insert on public.notes
  for each row execute function public.notes_set_user_id();
