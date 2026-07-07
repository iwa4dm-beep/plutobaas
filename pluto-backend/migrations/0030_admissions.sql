-- =============================================================================
-- School Admission Portal — Pluto (Supabase/PostgREST-compatible) setup
-- Run this ONCE in the Pluto SQL editor. Idempotent: safe to re-run.
-- =============================================================================

-- Extensions --------------------------------------------------------------
create extension if not exists pg_trgm;

-- Table -------------------------------------------------------------------
create table if not exists public.admissions (
  id                  text        primary key,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid        not null references auth.users(id) on delete cascade,

  -- Student
  student_name        text        not null check (length(btrim(student_name)) > 0),
  date_of_birth       date        not null,
  gender              text        not null check (gender in ('male','female','other')),
  blood_group         text,
  religion            text,
  nationality         text,
  previous_school     text,
  class_applying_for  text        not null,

  -- Parents
  father_name         text        not null,
  mother_name         text        not null,
  guardian_name       text,

  -- Contact
  mobile              text        not null check (length(btrim(mobile)) >= 7),
  alternate_mobile    text,
  email               text        check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address             text        not null,
  city                text,
  postal_code         text,

  notes               text
);

-- Indexes -----------------------------------------------------------------
create index if not exists admissions_student_name_trgm
  on public.admissions using gin (student_name gin_trgm_ops);
create index if not exists admissions_mobile_idx        on public.admissions (mobile);
create index if not exists admissions_created_at_idx    on public.admissions (created_at desc);
create index if not exists admissions_created_by_idx    on public.admissions (created_by);

-- updated_at trigger ------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_admissions_set_updated_at on public.admissions;
create trigger trg_admissions_set_updated_at
  before update on public.admissions
  for each row execute function public.set_updated_at();

-- Grants ------------------------------------------------------------------
-- Data API (PostgREST) requires explicit grants for anon/authenticated.
revoke all on public.admissions from anon;
grant select, insert, update, delete on public.admissions to authenticated;
grant all on public.admissions to service_role;

-- Row Level Security ------------------------------------------------------
alter table public.admissions enable row level security;

-- Any signed-in user can read any admission (needed for search UI).
drop policy if exists "authenticated can read admissions" on public.admissions;
create policy "authenticated can read admissions"
  on public.admissions for select
  to authenticated
  using (true);

-- Only signed-in users can create, and only as themselves.
drop policy if exists "authenticated can insert own admissions" on public.admissions;
create policy "authenticated can insert own admissions"
  on public.admissions for insert
  to authenticated
  with check (created_by = auth.uid());

-- Only the creator can update their record.
drop policy if exists "creator can update admissions" on public.admissions;
create policy "creator can update admissions"
  on public.admissions for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

-- Only the creator can delete their record.
drop policy if exists "creator can delete admissions" on public.admissions;
create policy "creator can delete admissions"
  on public.admissions for delete
  to authenticated
  using (created_by = auth.uid());

-- Realtime ----------------------------------------------------------------
-- Add the table to the supabase_realtime publication so clients get
-- INSERT/UPDATE/DELETE events. Wrapped in a DO block because ALTER
-- PUBLICATION ... ADD TABLE errors if the table is already a member.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'admissions'
  ) then
    execute 'alter publication supabase_realtime add table public.admissions';
  end if;
exception when undefined_object then
  -- publication doesn't exist on this instance — skip
  null;
end $$;

alter table public.admissions replica identity full;

-- Convenience view for admin dashboards -----------------------------------
create or replace view public.admissions_summary as
  select id, student_name, class_applying_for, mobile, created_at, created_by
    from public.admissions
   order by created_at desc;

grant select on public.admissions_summary to authenticated;
grant select on public.admissions_summary to service_role;
