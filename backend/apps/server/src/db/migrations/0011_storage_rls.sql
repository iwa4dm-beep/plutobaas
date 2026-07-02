-- Storage RLS & access rules
--
-- Prior state: any api-key holder could GET any object in any bucket
-- and could sign write URLs against anyone else's key. Ownership was
-- only enforced on DELETE.
--
-- This migration introduces bucket-level policy rows and per-bucket
-- caps so the server can enforce Supabase-style storage RLS:
--   * public / private buckets           (existing column)
--   * per-bucket per-role per-action ALLOW rows in bucket_policies
--   * size + MIME allow-list caps        (bucket columns)
--   * owner-only enforcement flag        (bucket column)
--
-- Roles used in bucket_policies.role:
--   'anon'          — anonymous API-key holders (no user JWT)
--   'authenticated' — signed-in user with a valid JWT
--   'owner'         — the user whose id matches objects.owner_id
--   'service_role'  — always allowed (bypasses this table)
--
-- Actions: read | write | delete | sign_read | sign_write
--
-- The server evaluates the most specific matching rule first (owner >
-- authenticated > anon). Absence of a rule = DENY.

begin;

alter table public.buckets
  add column if not exists owner_only    boolean     not null default true,
  add column if not exists max_size      bigint      not null default 26214400, -- 25 MiB
  add column if not exists allowed_mime  text[]                                 -- NULL = any
;

create table if not exists public.bucket_policies (
  id          uuid primary key default gen_random_uuid(),
  bucket      text not null references public.buckets(name) on delete cascade,
  role        text not null check (role in ('anon','authenticated','owner')),
  action      text not null check (action in ('read','write','delete','sign_read','sign_write')),
  allow       boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (bucket, role, action)
);

create index if not exists idx_bucket_policies_bucket on public.bucket_policies(bucket);
create index if not exists idx_objects_owner          on public.objects(owner_id);
create index if not exists idx_objects_bucket_prefix  on public.objects(bucket, key);

-- Seed sane defaults for pre-existing buckets so behavior doesn't
-- silently break: public buckets get anon-read + sign_read; every
-- bucket gets owner full-control + authenticated write/sign_write.
insert into public.bucket_policies (bucket, role, action, allow)
select b.name, 'owner', a, true
  from public.buckets b
  cross join unnest(array['read','write','delete','sign_read','sign_write']) a
  on conflict do nothing;

insert into public.bucket_policies (bucket, role, action, allow)
select b.name, 'authenticated', a, true
  from public.buckets b
  cross join unnest(array['write','sign_write']) a
  on conflict do nothing;

insert into public.bucket_policies (bucket, role, action, allow)
select b.name, 'anon', a, true
  from public.buckets b
  cross join unnest(array['read','sign_read']) a
 where b.public
  on conflict do nothing;

commit;
