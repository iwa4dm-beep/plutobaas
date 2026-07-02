# Phase 16 — AI & Vector

Phase 16 makes Pluto a first-class backend for AI-native applications:
embeddings, vector search, and a thin AI Gateway proxy so the frontend never
sees provider keys.

## Scope

1. **pgvector** — enable the extension, ship helper migrations for
   `embedding vector(N)` columns and cosine/IP/L2 distance indexes.
2. **Embeddings API** — `POST /ai/v1/embeddings` proxies to the configured
   provider (OpenAI, Voyage, Cohere, or the Lovable AI Gateway) and returns
   normalized `{ embedding: number[], usage }`.
3. **Vector store helper** — `POST /ai/v1/vector/:collection/search` runs
   parameterized `ORDER BY embedding <=> $1 LIMIT k` against any
   workspace-scoped table with an `embedding` column, honoring RLS.
4. **Chat proxy** — `POST /ai/v1/chat/completions` with SSE streaming,
   bill/count tokens per workspace, rate-limited per workspace + per model.
5. **AI usage ledger** — every call recorded to `ai_usage` with model,
   tokens_in/tokens_out, latency, cost estimate, workspace, and user.

## Deliverables

- Migration `0016_ai_vector.sql`:
  - `CREATE EXTENSION IF NOT EXISTS vector;`
  - `ai_providers`   — per-workspace provider config (driver, model
    defaults, API key stored encrypted in `service_settings`).
  - `ai_usage`       — call ledger, workspace-scoped, RLS + audit hook.
  - `ai_embeddings_demo` — small illustrative table with `embedding vector(1536)`
    + IVFFlat index, wired into the dashboard demo.
- Server module `modules/ai/`, gated by `PLUTO_ENABLE_AI=1`:
  - `POST /ai/v1/embeddings`
  - `POST /ai/v1/chat/completions`         (SSE)
  - `POST /ai/v1/vector/:collection/search`
  - `GET  /ai/v1/usage`                    (workspace/user filters)
- SDK: `live.ai.embed(...)`, `live.ai.chat(...)`, `live.ai.vectorSearch(...)`,
  `live.ai.usage(...)`.
- Dashboard: `/dashboard/ai` — provider config, usage graph, playground.

## Milestones

- **16.0** — this document + skeleton files + migration (current commit).
- **16.1** — Embeddings proxy against Lovable AI Gateway + OpenAI.
- **16.2** — Vector search endpoint with RLS-preserving parameterized SQL.
- **16.3** — Streaming chat proxy + token accounting.
- **16.4** — Dashboard playground + usage graph.

## Security notes

- The AI module never returns raw provider errors to the client; provider
  keys are read inside `service_settings` with the encryption key, decrypted
  at call time, and scrubbed from all log lines.
- Rate limits are enforced in-process (per workspace + per model) and again
  at the reverse-proxy layer via `X-RateLimit-*` headers.
- Vector search always parameterizes the query vector and validates the
  target table against a `PLUTO_AI_VECTOR_ALLOW` list — arbitrary SQL is
  never templated.
- All ledger rows include `workspace_id` and `actor_id` so the audit
  dashboard's user/workspace filters work out of the box.
