-- Phase 46 — Vector/AI production.
--
-- Layers on top of Phase 23 vec_collections/vec_documents:
--   * ai_models        — registry of chat + embedding models (id, provider, dims, price).
--   * vec_index_config — HNSW parameters per collection (m, ef_construction).
--   * vec_documents    — add tsv (tsvector) for hybrid search, model_id, chunk_of.
--   * vec_embed_jobs   — async embed pipeline queue: enqueue text → worker → upsert.
--   * rag_sources      — grouping/versioning of docs for RAG retrievals.

create table if not exists public.ai_models (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  slug           text not null,                    -- 'gemini-embedding-001'
  provider       text not null,                    -- 'google' | 'openai' | 'lovable'
  kind           text not null check (kind in ('chat','embedding','image','stt','tts')),
  vendor_model   text not null,                    -- exact gateway id e.g. 'google/gemini-embedding-001'
  dims           int,                              -- embedding output dimensionality
  price_per_1k   numeric(10, 6),                   -- $ per 1k input tokens (cost signal only)
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (workspace_id, slug)
);

revoke all on public.ai_models from authenticated, anon;
grant  all on public.ai_models to service_role;
alter table public.ai_models enable row level security;

create table if not exists public.vec_index_config (
  collection_id  uuid primary key references public.vec_collections(id) on delete cascade,
  index_type     text not null default 'hnsw' check (index_type in ('hnsw','ivfflat','none')),
  m              int  not null default 16   check (m between 4 and 96),
  ef_construction int not null default 64   check (ef_construction between 16 and 512),
  lists          int  not null default 100  check (lists between 10 and 4096),
  operator       text not null default 'vector_cosine_ops',
  applied        boolean not null default false,
  applied_at     timestamptz
);

revoke all on public.vec_index_config from authenticated, anon;
grant  all on public.vec_index_config to service_role;
alter table public.vec_index_config enable row level security;

-- Extend vec_documents for hybrid search + model tracking. All ADDs are
-- idempotent so re-running the migration on a live table is safe.
alter table public.vec_documents
  add column if not exists tsv        tsvector,
  add column if not exists model_id   uuid references public.ai_models(id),
  add column if not exists chunk_of   uuid,
  add column if not exists source_id  uuid;
create index if not exists vec_documents_tsv_idx    on public.vec_documents using gin(tsv);
create index if not exists vec_documents_source_idx on public.vec_documents(source_id);

-- Trigger keeps tsv in sync with content on insert/update. Uses English
-- stemmer — swap the config per collection if a caller needs another
-- language.
create or replace function public.vec_documents_tsv_refresh() returns trigger
language plpgsql as $$
begin
  new.tsv := to_tsvector('english', coalesce(new.content, ''));
  return new;
end
$$;

drop trigger if exists vec_documents_tsv_tg on public.vec_documents;
create trigger vec_documents_tsv_tg
  before insert or update of content on public.vec_documents
  for each row execute function public.vec_documents_tsv_refresh();

create table if not exists public.vec_embed_jobs (
  id              bigserial primary key,
  workspace_id    uuid,
  collection_id   uuid not null references public.vec_collections(id) on delete cascade,
  source_id       uuid,
  external_id     text,
  content         text not null,
  metadata        jsonb not null default '{}'::jsonb,
  model_slug      text,                            -- resolves via ai_models
  status          text not null default 'pending', -- pending|running|done|failed
  attempt         int  not null default 0,
  error           text,
  next_retry_at   timestamptz not null default now(),
  document_id     uuid,                            -- populated on success
  created_at      timestamptz not null default now()
);
create index if not exists ix_vej_due
  on public.vec_embed_jobs(status, next_retry_at) where status = 'pending';

revoke all on public.vec_embed_jobs from authenticated, anon;
grant  all on public.vec_embed_jobs to service_role;
alter table public.vec_embed_jobs enable row level security;

create table if not exists public.rag_sources (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  collection_id  uuid not null references public.vec_collections(id) on delete cascade,
  name           text not null,
  uri            text,                             -- optional pointer (URL, file path, etc.)
  version        int  not null default 1,
  chunk_size     int  not null default 1200,
  chunk_overlap  int  not null default 150,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique (workspace_id, collection_id, name, version)
);

revoke all on public.rag_sources from authenticated, anon;
grant  all on public.rag_sources to service_role;
alter table public.rag_sources enable row level security;
