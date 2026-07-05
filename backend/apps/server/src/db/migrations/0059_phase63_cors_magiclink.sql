-- Phase 63 — CORS allow-list + Email magic-link.
--
-- allowed_origins: per-workspace CORS whitelist consumed by the dynamic
-- origin callback in server.ts. NULL workspace_id = global rule.
-- email_magic_links: single-use passwordless sign-in tokens (hashed).

create table if not exists public.allowed_origins (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid,
  origin        text not null,
  note          text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  unique (workspace_id, origin)
);
create index if not exists idx_allowed_origins_ws on public.allowed_origins(workspace_id);

grant select, insert, update, delete on public.allowed_origins to authenticated;
grant all on public.allowed_origins to service_role;
alter table public.allowed_origins enable row level security;

-- Only service_role writes; authenticated members can read their workspace's
-- rules (RLS relies on workspace_id membership, handled by admin plugin).
create policy "svc_all_allowed_origins"
  on public.allowed_origins for all
  to service_role using (true) with check (true);

create table if not exists public.email_magic_links (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  token_hash   text not null unique,
  redirect_to  text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz
);
create index if not exists idx_email_magic_links_email on public.email_magic_links(email);
create index if not exists idx_email_magic_links_expires on public.email_magic_links(expires_at);

grant select, insert, update on public.email_magic_links to authenticated;
grant all on public.email_magic_links to service_role;
alter table public.email_magic_links enable row level security;

create policy "svc_all_email_magic_links"
  on public.email_magic_links for all
  to service_role using (true) with check (true);
