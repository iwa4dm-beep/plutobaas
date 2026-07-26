-- ─────────────────────────────────────────────────────────────
-- Pluto BaaS — Next.js starter schema (Auth + RLS + Webhooks)
-- Apply once per project:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f setup.sql
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────

-- 1. Table -----------------------------------------------------
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists notes_user_id_created_at_idx
  on public.notes (user_id, created_at desc);

-- 2. GRANTs (Data API requires explicit grants — RLS alone is not enough)
grant select, insert, update, delete on public.notes to authenticated;
grant all on public.notes to service_role;
-- NOTE: no `anon` grant — notes are private per user.

-- 3. RLS -------------------------------------------------------
alter table public.notes enable row level security;

drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own"
  on public.notes for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own"
  on public.notes for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own"
  on public.notes for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own"
  on public.notes for delete
  to authenticated
  using (user_id = auth.uid());

-- 4. Default user_id trigger — clients can omit user_id on insert.
create or replace function public.notes_set_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists notes_set_user_id on public.notes;
create trigger notes_set_user_id
  before insert on public.notes
  for each row execute function public.notes_set_user_id();

-- 5. Test users (optional) -------------------------------------
-- Pluto's auth API is the supported way to create users. Prefer
-- calling POST /auth/v1/signup from `scripts/provision-test-users.mjs`
-- (bundled with the starter) instead of inserting into auth.users here.
-- The block below is an admin-only escape hatch when the auth API is
-- unreachable and you need seed users for local dev.
--
-- do $$
-- declare u1 uuid; u2 uuid;
-- begin
--   insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role)
--   values (gen_random_uuid(), 'alice+e2e@example.com',
--           crypt('StrongPass!2026', gen_salt('bf')), now(), 'authenticated', 'authenticated')
--   on conflict (email) do nothing returning id into u1;
--   insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role)
--   values (gen_random_uuid(), 'bob+e2e@example.com',
--           crypt('StrongPass!2026', gen_salt('bf')), now(), 'authenticated', 'authenticated')
--   on conflict (email) do nothing returning id into u2;
-- end $$;
