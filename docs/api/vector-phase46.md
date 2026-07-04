# Vector / AI Production — Phase 46

pgvector HNSW indexes, an async embedding pipeline, hybrid (vector + BM25/tsvector) search with RRF fusion, RAG helpers, and a per-workspace model registry.

## Enable

```
PLUTO_ENABLE_VECTOR_V2=1
LOVABLE_API_KEY=<gateway key>              # required for embed pipeline
LOVABLE_AI_BASE_URL=https://ai.gateway.lovable.dev
```

## Model registry — `/vec/v2/models`

```
POST /vec/v2/models
{ "slug": "gemini-embedding-001", "provider": "google", "kind": "embedding",
  "vendor_model": "google/gemini-embedding-001", "dims": 3072 }
```

Registry rows are looked up by `slug`. Ingest and search accept `model_slug` and resolve to the exact `vendor/model` id sent to the gateway. `dimensions` override is only forwarded for `openai/text-embedding-3-*` models.

## HNSW / IVFFLAT indexes — `/vec/v2/collections/:id/index`

```
PUT   /vec/v2/collections/:id/index
{ "index_type": "hnsw", "m": 16, "ef_construction": 64,
  "operator": "vector_cosine_ops" }

POST  /vec/v2/collections/:id/index/apply     — runs CREATE EXTENSION vector + CREATE INDEX
```

Applied partially per `collection_id` so multiple collections can coexist on the shared `vec_documents` table without a full-table rebuild. Requires the pgvector extension; the endpoint installs it if missing.

## Embed pipeline — `/vec/v2/collections/:id/ingest`

Idempotent async ingestion. Documents are chunked (default 1200 chars, 150 overlap), a job row is inserted per chunk, and a background sweeper (every 5 s) batches them by model and posts to the Lovable AI Gateway `/v1/embeddings` endpoint.

```
POST /vec/v2/collections/:id/ingest
{ "docs": [{ "external_id": "doc-42", "content": "…long text…", "metadata": {…} }],
  "chunk_size": 1200, "chunk_overlap": 150,
  "model_slug": "gemini-embedding-001" }
```

Retries: exponential backoff (2^n s, cap 5 min), max 5 attempts before `failed`.

- `POST /vec/v2/embed/tick` — drain manually (admin).
- `GET  /vec/v2/embed/jobs` — recent job status per workspace.

Batching honours provider caps: Google `google/*` → 100 items/req, OpenAI → 1024. Vectors are re-ordered by `data[].index` before persisting.

## Hybrid search — `/vec/v2/collections/:id/search`

```
POST /vec/v2/collections/:id/search
{ "query": "how do I rotate API keys?", "top_k": 10, "fulltext": true,
  "model_slug": "gemini-embedding-001" }
```

Two ranked lists are produced independently:

1. Vector — cosine similarity over the collection.
2. Full-text — `websearch_to_tsquery('english', …)` + `ts_rank` on `vec_documents.tsv` (kept in sync by a trigger).

Then fused with **Reciprocal Rank Fusion** (`k = 60`, canonical value from TREC):

```
score(doc) = Σ 1 / (k + rank_in_list)
```

Set `"fulltext": false` for pure vector search.

## RAG helper — `/vec/v2/rag/query`

```
POST /vec/v2/rag/query
{ "query": "...", "collection_id": "...", "top_k": 5, "max_context": 4000 }
```

Runs hybrid search internally, then concatenates the top hits into a bounded context block with `[[source:N]]` headers ready to drop into an LLM prompt:

```json
{
  "context":   "[[source:1]]\n…chunk…\n[[source:2]]\n…chunk…\n",
  "sources":   [{ "n": 1, "metadata": {…} }, …],
  "truncated": false
}
```

## Notes

- `vec_documents.tsv` is maintained by a trigger — no application code needs to keep it in sync.
- The vector list is currently scored in JS over `embedding` stored as `jsonb` so the module works even without pgvector installed. Once the HNSW index is applied, swap in `order by embedding <=> $1` from the Data API (Phase 44 embed endpoint reads the same table).
- All jobs and hits are workspace-scoped via `x-workspace-id`.
