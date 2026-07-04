-- Phase 54 — Object Storage v4: versioning, retention locks, cross-region replication.

create table if not exists public.storage4_object_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  bucket text not null,
  object_key text not null,
  version_id text not null,
  size_bytes bigint not null,
  content_type text,
  checksum_sha256 text not null,
  storage_uri text not null,
  is_delete_marker boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (workspace_id, bucket, object_key, version_id)
);

create table if not exists public.storage4_retention_locks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  bucket text not null,
  object_key text not null,
  version_id text not null,
  mode text not null check (mode in ('governance','compliance')),
  retain_until timestamptz not null,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, bucket, object_key, version_id)
);

create table if not exists public.storage4_replication_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  bucket text not null,
  object_key text not null,
  version_id text not null,
  source_region text not null,
  target_region text not null,
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending','running','succeeded','failed','skipped')),
  attempts int not null default 0,
  last_error text,
  checksum_verified boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create index if not exists s4_ver_key on public.storage4_object_versions (workspace_id, bucket, object_key, created_at desc);
create index if not exists s4_repl_next on public.storage4_replication_jobs (status, next_attempt_at);

grant select, insert, update, delete on public.storage4_object_versions to authenticated;
grant select, insert, update, delete on public.storage4_retention_locks to authenticated;
grant select, insert, update, delete on public.storage4_replication_jobs to authenticated;
grant all on public.storage4_object_versions, public.storage4_retention_locks,
             public.storage4_replication_jobs to service_role;

alter table public.storage4_object_versions enable row level security;
alter table public.storage4_retention_locks enable row level security;
alter table public.storage4_replication_jobs enable row level security;

create policy s4_ver_ws on public.storage4_object_versions for all to authenticated
  using (workspace_id = public.current_workspace_id()) with check (workspace_id = public.current_workspace_id());
create policy s4_ret_ws on public.storage4_retention_locks for all to authenticated
  using (workspace_id = public.current_workspace_id()) with check (workspace_id = public.current_workspace_id());
create policy s4_rep_ws on public.storage4_replication_jobs for all to authenticated
  using (workspace_id = public.current_workspace_id()) with check (workspace_id = public.current_workspace_id());
