-- Phase 16 — AI & Vector
--
-- Enables pgvector, ships a per-workspace provider registry, a usage
-- ledger, and a small demo embeddings table that the dashboard playground
-- points at. Handlers land in 16.1+.

BEGIN;

-- pgvector powers the ORDER BY embedding <=> $1 vector search path.
-- Wrapped in a DO so the migration still succeeds on the developer box
-- when the extension binary isn't installed — we log and continue.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available: %. Vector features will 501 until installed.', SQLERRM;
  END;
END $$;

-- ---------------- Providers ----------------
CREATE TABLE IF NOT EXISTS public.ai_providers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  slug           text NOT NULL,
  driver         text NOT NULL CHECK (driver IN ('lovable','openai','voyage','cohere','anthropic')),
  default_chat_model      text,
  default_embed_model     text,
  -- The API key is NOT stored here — it lives in service_settings under
  -- key `ai.provider.<slug>.api_key` so we get the same encryption path
  -- as every other secret. Only non-secret metadata lives in `config`.
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS ai_providers_ws_idx ON public.ai_providers(workspace_id);

-- ---------------- Usage ledger ----------------
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_id       uuid REFERENCES public.auth_users(id) ON DELETE SET NULL,
  provider_slug  text NOT NULL,
  model          text NOT NULL,
  endpoint       text NOT NULL CHECK (endpoint IN ('embeddings','chat','vector.search')),
  tokens_in      integer NOT NULL DEFAULT 0,
  tokens_out     integer NOT NULL DEFAULT 0,
  latency_ms     integer NOT NULL DEFAULT 0,
  status_code    integer NOT NULL DEFAULT 200,
  cost_usd_micro bigint  NOT NULL DEFAULT 0, -- USD * 1e6 to avoid float drift
  request_id     text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_ws_created_idx
  ON public.ai_usage(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_actor_idx
  ON public.ai_usage(actor_id, created_at DESC);

-- ---------------- Demo embeddings table ----------------
-- Only created when pgvector is present. Powers the dashboard playground
-- and the vector-search integration tests.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS public.ai_embeddings_demo (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
      content       text NOT NULL,
      metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
      embedding     vector(1536),
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ai_embeddings_demo_ws_idx
      ON public.ai_embeddings_demo(workspace_id);
    -- IVFFlat needs ANALYZE data to be useful; created empty is fine.
    BEGIN
      CREATE INDEX IF NOT EXISTS ai_embeddings_demo_vec_idx
        ON public.ai_embeddings_demo USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ivfflat index deferred: %', SQLERRM;
    END;

    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_embeddings_demo TO authenticated';
    EXECUTE 'GRANT ALL ON public.ai_embeddings_demo TO service_role';
    EXECUTE 'ALTER TABLE public.ai_embeddings_demo ENABLE ROW LEVEL SECURITY';
    EXECUTE $p$CREATE POLICY ai_embeddings_demo_ws ON public.ai_embeddings_demo
              FOR ALL TO authenticated USING (workspace_id = current_workspace_id())
              WITH CHECK (workspace_id = current_workspace_id())$p$;
  END IF;
END $$;

-- ---------------- Grants + RLS ----------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_providers TO authenticated;
GRANT SELECT, INSERT                 ON public.ai_usage     TO authenticated;
GRANT ALL ON public.ai_providers, public.ai_usage TO service_role;
GRANT SELECT, INSERT ON public.ai_usage TO pluto_jobs;
GRANT USAGE, SELECT ON SEQUENCE public.ai_usage_id_seq TO authenticated, pluto_jobs, service_role;

ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage     ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_providers_ws ON public.ai_providers
  FOR ALL TO authenticated USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

-- Usage rows are workspace-scoped; users see their own, admins see the workspace.
CREATE POLICY ai_usage_ws_read ON public.ai_usage
  FOR SELECT TO authenticated USING (workspace_id = current_workspace_id());

CREATE POLICY ai_usage_ws_insert ON public.ai_usage
  FOR INSERT TO authenticated WITH CHECK (workspace_id = current_workspace_id());

COMMIT;
