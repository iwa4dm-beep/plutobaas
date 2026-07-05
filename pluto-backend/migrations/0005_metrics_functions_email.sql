-- Pluto BaaS — Phase 8: metrics, edge functions, email verification tokens

-- Edge functions (user-defined server-side JS handlers)
CREATE TABLE IF NOT EXISTS admin.functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES admin.projects(id) ON DELETE CASCADE,
  slug text NOT NULL,
  code text NOT NULL,             -- ES module source; must export default async (req, ctx) => Response
  runtime text NOT NULL DEFAULT 'node-worker',
  memory_mb int NOT NULL DEFAULT 128 CHECK (memory_mb BETWEEN 32 AND 1024),
  timeout_ms int NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 60000),
  env jsonb NOT NULL DEFAULT '{}'::jsonb,
  verify_jwt boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (project_id, slug)
);
CREATE INDEX IF NOT EXISTS functions_project_idx ON admin.functions (project_id);

-- Email verification / password recovery tokens
CREATE TABLE IF NOT EXISTS auth.email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('signup', 'recovery', 'email_change', 'invite')),
  token_hash text NOT NULL UNIQUE,
  new_email text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON auth.email_tokens (user_id);

-- Track sent emails (audit)
CREATE TABLE IF NOT EXISTS admin.email_log (
  id bigserial PRIMARY KEY,
  to_addr text NOT NULL,
  subject text NOT NULL,
  template text,
  status text NOT NULL,           -- 'sent' | 'failed'
  error text,
  created_at timestamptz DEFAULT now()
);
