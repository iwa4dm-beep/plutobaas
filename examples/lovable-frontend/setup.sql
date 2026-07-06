-- ─────────────────────────────────────────────────────────────
-- backend-joy: users / roles / storage bootstrap
-- Run once per project via the Studio SQL editor
--   Dashboard → SQL → paste → Run
-- All statements are idempotent.
-- ─────────────────────────────────────────────────────────────

-- 1. Profiles table linked to auth.users
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to service_role;

alter table public.profiles enable row level security;

drop policy if exists "profiles_self_select" on public.profiles;
create policy "profiles_self_select" on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists "profiles_self_upsert" on public.profiles;
create policy "profiles_self_upsert" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
  for update to authenticated using (auth.uid() = id);

-- 2. Auto-create profile row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Roles (never store on profiles → privilege-escalation risk)
do $$ begin
  create type public.app_role as enum ('admin','moderator','user');
exception when duplicate_object then null; end $$;

create table if not exists public.user_roles (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users(id) on delete cascade,
  role     public.app_role not null,
  unique (user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

drop policy if exists "roles_self_read" on public.user_roles;
create policy "roles_self_read" on public.user_roles
  for select to authenticated using (auth.uid() = user_id);

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles where user_id = _user_id and role = _role
  );
$$;

-- 4. Example app table (notes) protected by RLS
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  body        text,
  created_at  timestamptz not null default now()
);

grant select, insert, update, delete on public.notes to authenticated;
grant all on public.notes to service_role;

alter table public.notes enable row level security;

drop policy if exists "notes_owner_all" on public.notes;
create policy "notes_owner_all" on public.notes
  for all to authenticated
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "notes_admin_read" on public.notes;
create policy "notes_admin_read" on public.notes
  for select to authenticated using (public.has_role(auth.uid(), 'admin'));

-- 5. Storage bucket for uploads (per-user folder policy)
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', true)
on conflict (id) do nothing;

drop policy if exists "uploads_read_public" on storage.objects;
create policy "uploads_read_public" on storage.objects
  for select using (bucket_id = 'uploads');

drop policy if exists "uploads_owner_write" on storage.objects;
create policy "uploads_owner_write" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "uploads_owner_modify" on storage.objects;
create policy "uploads_owner_modify" on storage.objects
  for update to authenticated using (
    bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "uploads_owner_delete" on storage.objects;
create policy "uploads_owner_delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text
  );
