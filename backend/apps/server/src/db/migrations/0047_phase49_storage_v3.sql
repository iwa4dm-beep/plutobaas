-- Phase 49 — Storage v3: signed uploads, resumable multipart, image transform cache, lifecycle rules.

-- Signed upload grants: short-lived, single-use tokens minted server-side so
-- clients can PUT bytes directly without holding long credentials.
create table if not exists public.st3_signed_uploads (
  token         text primary key,
  workspace_id  uuid,
  bucket        text not null,
  object_key    text not null,
  content_type  text,
  max_bytes     bigint not null default 25 * 1024 * 1024,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);
create index if not exists st3_signed_uploads_exp_idx on public.st3_signed_uploads(expires_at);

grant select, insert, update on public.st3_signed_uploads to authenticated;
grant all on public.st3_signed_uploads to service_role;
alter table public.st3_signed_uploads enable row level security;
create policy st3_signed_uploads_owner on public.st3_signed_uploads
  for all to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

-- Resumable multipart upload sessions. Chunks are tracked per part_number so
-- clients can retry individual parts and completion is idempotent.
create table if not exists public.st3_upload_sessions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid,
  bucket        text not null,
  object_key    text not null,
  content_type  text,
  total_bytes   bigint,
  part_size     integer not null default 8 * 1024 * 1024,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  aborted_at    timestamptz,
  status        text not null default 'active'
                check (status in ('active','completed','aborted'))
);
create index if not exists st3_upload_sessions_ws_idx on public.st3_upload_sessions(workspace_id);
create index if not exists st3_upload_sessions_status_idx on public.st3_upload_sessions(status);

create table if not exists public.st3_upload_parts (
  session_id    uuid not null references public.st3_upload_sessions(id) on delete cascade,
  part_number   integer not null check (part_number between 1 and 10000),
  etag          text not null,
  size_bytes    bigint not null,
  received_at   timestamptz not null default now(),
  primary key (session_id, part_number)
);

grant select, insert, update, delete on public.st3_upload_sessions to authenticated;
grant select, insert, update, delete on public.st3_upload_parts to authenticated;
grant all on public.st3_upload_sessions, public.st3_upload_parts to service_role;
alter table public.st3_upload_sessions enable row level security;
alter table public.st3_upload_parts    enable row level security;
create policy st3_upload_sessions_owner on public.st3_upload_sessions
  for all to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy st3_upload_parts_owner on public.st3_upload_parts
  for all to authenticated using (
    exists (select 1 from public.st3_upload_sessions s where s.id = session_id and s.created_by = auth.uid())
  ) with check (
    exists (select 1 from public.st3_upload_sessions s where s.id = session_id and s.created_by = auth.uid())
  );

-- Image transform cache — CDN-friendly, keyed by (bucket, object, transform hash).
create table if not exists public.st3_transform_cache (
  cache_key     text primary key,           -- sha256(bucket|key|transform)
  bucket        text not null,
  object_key    text not null,
  variant       jsonb not null,             -- {w,h,fit,quality,format}
  content_type  text not null,
  size_bytes    bigint not null,
  etag          text not null,
  cdn_url       text,
  hits          bigint not null default 0,
  created_at    timestamptz not null default now(),
  last_hit_at   timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index if not exists st3_transform_cache_exp_idx on public.st3_transform_cache(expires_at);
create index if not exists st3_transform_cache_bkt_idx on public.st3_transform_cache(bucket, object_key);

grant select, insert, update, delete on public.st3_transform_cache to authenticated;
grant all on public.st3_transform_cache to service_role;
alter table public.st3_transform_cache enable row level security;
create policy st3_transform_cache_read on public.st3_transform_cache
  for select to authenticated using (true);

-- Per-bucket lifecycle rules: expire / tier / cleanup incomplete uploads.
create table if not exists public.st3_lifecycle_rules (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid,
  bucket        text not null,
  name          text not null,
  prefix        text not null default '',
  action        text not null check (action in ('expire','tier','abort_incomplete')),
  after_days    integer not null check (after_days >= 0),
  target_tier   text,                        -- 'standard','infrequent','archive'
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  last_run_at   timestamptz,
  unique (workspace_id, bucket, name)
);

create table if not exists public.st3_lifecycle_runs (
  id            bigserial primary key,
  rule_id       uuid not null references public.st3_lifecycle_rules(id) on delete cascade,
  ran_at        timestamptz not null default now(),
  matched       integer not null default 0,
  affected      integer not null default 0,
  error         text
);

grant select, insert, update, delete on public.st3_lifecycle_rules to authenticated;
grant select on public.st3_lifecycle_runs to authenticated;
grant all on public.st3_lifecycle_rules, public.st3_lifecycle_runs to service_role;
alter table public.st3_lifecycle_rules enable row level security;
alter table public.st3_lifecycle_runs  enable row level security;
create policy st3_lifecycle_rules_read on public.st3_lifecycle_rules
  for select to authenticated using (true);
create policy st3_lifecycle_runs_read on public.st3_lifecycle_runs
  for select to authenticated using (true);
