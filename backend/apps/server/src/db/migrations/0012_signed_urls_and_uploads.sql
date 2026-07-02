-- Phase 12: hardened signed URLs + multipart/resumable uploads.
--
-- Prior state:
--   * Local signed URLs were stateless HMACs: expiry & mode were in
--     the query string but there was no server-side record, so
--     revocation was impossible and one-time consumption was not
--     supported.
--   * Large uploads had to fit in a single multipart/form-data body.
--
-- This migration introduces two auditable, RLS-enforced tables:
--
-- `storage_signed_grants`
--   Every signed URL mint records a row. The verifier requires the row
--   to exist, be unrevoked, be unexpired, and (if one_time) unused.
--   `used_at` is stamped atomically on successful consumption so a
--   captured URL cannot be replayed. Every mint / use / revoke also
--   writes an audit_event row via the app layer.
--
-- `storage_uploads` + `storage_upload_parts`
--   Server-managed multipart sessions. Init reserves a session with the
--   final bucket/key/size/mime; each part is stored under a staging
--   prefix; complete concatenates + validates + moves the object into
--   place. RLS write access is re-evaluated on every part and on
--   complete so a session cannot outlive its permissions.

begin;

create table if not exists public.storage_signed_grants (
  id            uuid primary key default gen_random_uuid(),
  bucket        text not null references public.buckets(name) on delete cascade,
  key           text not null,
  mode          text not null check (mode in ('read','write')),
  one_time      boolean not null default false,
  expires_at    timestamptz not null,
  issued_by     uuid references public.users(id) on delete set null,
  workspace_id  uuid,
  used_at       timestamptz,
  used_ip       inet,
  revoked_at    timestamptz,
  revoked_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_ssg_bucket_key on public.storage_signed_grants(bucket, key);
create index if not exists idx_ssg_expires    on public.storage_signed_grants(expires_at)
  where revoked_at is null and used_at is null;

grant select on public.storage_signed_grants to authenticated;
grant all    on public.storage_signed_grants to service_role;

alter table public.storage_signed_grants enable row level security;
drop policy if exists ssg_admin_read on public.storage_signed_grants;
create policy ssg_admin_read on public.storage_signed_grants
  for select to authenticated
  using (public.is_admin() or issued_by = auth.uid());

-- ── Multipart / resumable uploads ────────────────────────────────
create table if not exists public.storage_uploads (
  id            uuid primary key default gen_random_uuid(),
  bucket        text not null references public.buckets(name) on delete cascade,
  key           text not null,
  size          bigint not null,
  part_size     integer not null,
  content_type  text not null,
  owner_id      uuid references public.users(id) on delete set null,
  workspace_id  uuid,
  status        text not null default 'in_progress'
                  check (status in ('in_progress','completed','aborted','failed')),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  aborted_at    timestamptz
);

create index if not exists idx_uploads_status on public.storage_uploads(status, created_at);

create table if not exists public.storage_upload_parts (
  upload_id    uuid not null references public.storage_uploads(id) on delete cascade,
  part_number  integer not null check (part_number >= 1 and part_number <= 10000),
  size         integer not null,
  etag         text not null,
  uploaded_at  timestamptz not null default now(),
  primary key (upload_id, part_number)
);

grant select, insert, update, delete on public.storage_uploads      to authenticated;
grant select, insert, update, delete on public.storage_upload_parts to authenticated;
grant all on public.storage_uploads      to service_role;
grant all on public.storage_upload_parts to service_role;

alter table public.storage_uploads      enable row level security;
alter table public.storage_upload_parts enable row level security;

drop policy if exists uploads_owner_all on public.storage_uploads;
create policy uploads_owner_all on public.storage_uploads
  for all to authenticated
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists upload_parts_owner_all on public.storage_upload_parts;
create policy upload_parts_owner_all on public.storage_upload_parts
  for all to authenticated
  using (exists (select 1 from public.storage_uploads u
                  where u.id = upload_id and (u.owner_id = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.storage_uploads u
                  where u.id = upload_id and (u.owner_id = auth.uid() or public.is_admin())));

commit;

-- +migrate down
drop table if exists public.storage_upload_parts;
drop table if exists public.storage_uploads;
drop table if exists public.storage_signed_grants;
