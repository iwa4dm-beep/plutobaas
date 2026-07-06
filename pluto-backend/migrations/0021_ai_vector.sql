-- Phase 15 · 0021 — AI request log + vector embeddings store
-- Powers /ai/v1/* and the Vector page. pgvector optional; falls back to jsonb.

create extension if not exists vector;

create schema if not exists ai;

create table if not exists ai.requests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  user_id       uuid references auth.users(id)      on delete set null,
  provider      text not null,       -- 'openai' | 'anthropic' | 'lovable' | ...
  model         text not null,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens  integer,
  cost_cents    integer,
  status        text check (status in ('ok','error','timeout')) default 'ok',
  latency_ms    integer,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists ai_requests_ws_ts_idx on ai.requests(workspace_id, created_at desc);

create table if not exists ai.collections (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  name          text not null,
  dimensions    integer not null default 1536,
  metric        text not null check (metric in ('cosine','l2','ip')) default 'cosine',
  created_at    timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists ai.embeddings (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid not null references ai.collections(id) on delete cascade,
  document_id   text not null,
  content       text,
  embedding     vector(1536),
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists embeddings_collection_idx on ai.embeddings(collection_id);
-- HNSW index (pgvector >= 0.5). Ignore if unsupported.
do $$ begin
  execute 'create index if not exists embeddings_hnsw on ai.embeddings using hnsw (embedding vector_cosine_ops)';
exception when others then null; end $$;

grant usage on schema ai to authenticated, service_role;
grant select, insert, update, delete on ai.requests, ai.collections, ai.embeddings to authenticated;
grant all on ai.requests, ai.collections, ai.embeddings to service_role;

alter table ai.requests    enable row level security;
alter table ai.collections enable row level security;
alter table ai.embeddings  enable row level security;

drop policy if exists ai_requests_read on ai.requests;
create policy ai_requests_read on ai.requests for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from admin.workspace_members m
             where m.workspace_id = ai.requests.workspace_id and m.user_id = auth.uid()
               and m.role in ('owner','admin'))
);

drop policy if exists ai_collections_read on ai.collections;
create policy ai_collections_read on ai.collections for select to authenticated using (
  exists (select 1 from admin.workspace_members m
          where m.workspace_id = ai.collections.workspace_id and m.user_id = auth.uid())
);

drop policy if exists ai_embeddings_read on ai.embeddings;
create policy ai_embeddings_read on ai.embeddings for select to authenticated using (
  exists (select 1 from ai.collections c
          join admin.workspace_members m on m.workspace_id = c.workspace_id
          where c.id = ai.embeddings.collection_id and m.user_id = auth.uid())
);
