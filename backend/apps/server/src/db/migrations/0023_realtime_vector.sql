-- Phase 23 — Realtime Presence/Broadcast history + Vector search corpus.

create table if not exists public.rt_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  name text not null,
  kind text not null default 'broadcast', -- 'broadcast' | 'presence'
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists public.rt_broadcasts (
  id bigserial primary key,
  channel_id uuid not null references public.rt_channels(id) on delete cascade,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  sender text,
  created_at timestamptz not null default now()
);
create index if not exists rt_broadcasts_chan_time_idx on public.rt_broadcasts(channel_id, created_at desc);

create table if not exists public.rt_presence (
  channel_id uuid not null references public.rt_channels(id) on delete cascade,
  member_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  last_seen timestamptz not null default now(),
  primary key (channel_id, member_key)
);

-- Vector search corpus (uses pgvector if installed, jsonb fallback otherwise).
create table if not exists public.vec_collections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  name text not null,
  dims integer not null default 1536,
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists public.vec_documents (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.vec_collections(id) on delete cascade,
  external_id text,
  content text not null,
  embedding jsonb not null default '[]'::jsonb, -- float[] as jsonb (portable fallback)
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists vec_documents_coll_idx on public.vec_documents(collection_id);

grant select, insert, update, delete on public.rt_channels    to authenticated;
grant select, insert, update, delete on public.rt_broadcasts  to authenticated;
grant select, insert, update, delete on public.rt_presence    to authenticated;
grant select, insert, update, delete on public.vec_collections to authenticated;
grant select, insert, update, delete on public.vec_documents   to authenticated;
grant usage, select on sequence public.rt_broadcasts_id_seq to authenticated;
grant all on public.rt_channels, public.rt_broadcasts, public.rt_presence,
             public.vec_collections, public.vec_documents to service_role;

alter table public.rt_channels    enable row level security;
alter table public.rt_broadcasts  enable row level security;
alter table public.rt_presence    enable row level security;
alter table public.vec_collections enable row level security;
alter table public.vec_documents   enable row level security;

create policy if not exists rt_channels_ws on public.rt_channels
  for all to authenticated using (true) with check (true);
create policy if not exists rt_broadcasts_ws on public.rt_broadcasts
  for all to authenticated using (true) with check (true);
create policy if not exists rt_presence_ws on public.rt_presence
  for all to authenticated using (true) with check (true);
create policy if not exists vec_coll_ws on public.vec_collections
  for all to authenticated using (true) with check (true);
create policy if not exists vec_docs_ws on public.vec_documents
  for all to authenticated using (true) with check (true);
