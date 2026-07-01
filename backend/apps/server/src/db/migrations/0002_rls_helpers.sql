-- Handy RLS helpers for user-authored tables. Example use:
--
--   create table public.notes (
--     id uuid primary key default gen_random_uuid(),
--     user_id uuid not null default public.current_user_id(),
--     body text not null,
--     created_at timestamptz not null default now()
--   );
--   alter table public.notes enable row level security;
--   create policy "own" on public.notes
--     using (user_id = public.current_user_id())
--     with check (user_id = public.current_user_id());

create or replace function public.is_admin() returns boolean
language sql stable as $$
  select exists (
    select 1 from public.users u
    where u.id = public.current_user_id() and u.role = 'admin'
  )
$$;
