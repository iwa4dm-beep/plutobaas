-- Phase 15 — Advanced Auth (MFA · SSO · Templates · Push)
--
-- Skeleton migration. Ships all tables so the SDK / OpenAPI generator and
-- the integration tests have real DDL to point at. Handlers land in 15.1+.

BEGIN;

-- ---------------- MFA ----------------
CREATE TABLE IF NOT EXISTS public.auth_mfa_factors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  factor_type    text NOT NULL CHECK (factor_type IN ('totp','webauthn')),
  friendly_name  text,
  -- AES-256-GCM ciphertext of the TOTP shared secret (base32). Never
  -- exposed via any API surface — used only by the verify step.
  secret_ct      bytea,
  secret_nonce   bytea,
  status         text NOT NULL DEFAULT 'unverified'
                 CHECK (status IN ('unverified','verified','revoked')),
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_mfa_factors_user_idx ON public.auth_mfa_factors(user_id);

CREATE TABLE IF NOT EXISTS public.auth_mfa_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_id    uuid NOT NULL REFERENCES public.auth_mfa_factors(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_mfa_challenges_expiry_idx
  ON public.auth_mfa_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.auth_recovery_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.auth_users(id) ON DELETE CASCADE,
  code_hash    text NOT NULL,               -- argon2id
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_recovery_codes_user_idx ON public.auth_recovery_codes(user_id);

-- ---------------- SSO ----------------
CREATE TABLE IF NOT EXISTS public.auth_sso_providers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  slug           text NOT NULL,   -- URL-safe, used in /auth/v1/sso/:slug/*
  display_name   text NOT NULL,
  protocol       text NOT NULL CHECK (protocol IN ('oidc','saml')),
  -- OIDC: issuer, client_id, client_secret_ct, redirect_uri, scopes[]
  -- SAML: entity_id, sso_url, x509_cert, name_id_format
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS auth_sso_providers_ws_idx ON public.auth_sso_providers(workspace_id);

CREATE TABLE IF NOT EXISTS public.auth_sso_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES public.auth_sso_providers(id) ON DELETE CASCADE,
  state           text NOT NULL,
  nonce           text,
  pkce_verifier   text,
  redirect_to     text,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sso_sessions_state_idx
  ON public.auth_sso_sessions(state) WHERE consumed_at IS NULL;

-- ---------------- Templates ----------------
CREATE TABLE IF NOT EXISTS public.comms_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  slug           text NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email','sms','push')),
  version        integer NOT NULL DEFAULT 1,
  is_active      boolean NOT NULL DEFAULT true,
  subject        text,                              -- email only
  body_text      text,
  body_html      text,                              -- email only
  variables      jsonb NOT NULL DEFAULT '[]'::jsonb, -- ["name","link",...]
  created_by     uuid REFERENCES public.auth_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug, version)
);
CREATE INDEX IF NOT EXISTS comms_templates_ws_slug_idx
  ON public.comms_templates(workspace_id, slug);

-- ---------------- Push notifications ----------------
CREATE TABLE IF NOT EXISTS public.push_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES public.auth_users(id) ON DELETE CASCADE,
  platform        text NOT NULL CHECK (platform IN ('ios','android','web')),
  token           text NOT NULL,
  bundle_id       text,
  app_version     text,
  disabled_at     timestamptz,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, token)
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON public.push_devices(user_id);

CREATE TABLE IF NOT EXISTS public.push_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  device_id      uuid REFERENCES public.push_devices(id) ON DELETE SET NULL,
  actor_id       uuid REFERENCES public.auth_users(id) ON DELETE SET NULL,
  title          text,
  body           text,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','delivered','failed')),
  provider_id    text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz
);
CREATE INDEX IF NOT EXISTS push_messages_ws_created_idx
  ON public.push_messages(workspace_id, created_at DESC);

-- ---------------- Grants + RLS ----------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_mfa_factors,
                                        public.auth_mfa_challenges,
                                        public.auth_recovery_codes,
                                        public.auth_sso_providers,
                                        public.auth_sso_sessions,
                                        public.comms_templates,
                                        public.push_devices,
                                        public.push_messages TO authenticated;
GRANT ALL ON public.auth_mfa_factors,
             public.auth_mfa_challenges,
             public.auth_recovery_codes,
             public.auth_sso_providers,
             public.auth_sso_sessions,
             public.comms_templates,
             public.push_devices,
             public.push_messages TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.push_messages TO pluto_jobs;

ALTER TABLE public.auth_mfa_factors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_mfa_challenges   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_recovery_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sso_providers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sso_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comms_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_devices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_messages         ENABLE ROW LEVEL SECURITY;

-- Users can only see their own MFA factors + challenges + recovery codes.
CREATE POLICY mfa_factors_self ON public.auth_mfa_factors
  FOR ALL TO authenticated USING (user_id = current_user_id())
  WITH CHECK (user_id = current_user_id());

CREATE POLICY mfa_challenges_self ON public.auth_mfa_challenges
  FOR ALL TO authenticated USING (user_id = current_user_id())
  WITH CHECK (user_id = current_user_id());

CREATE POLICY recovery_codes_self ON public.auth_recovery_codes
  FOR ALL TO authenticated USING (user_id = current_user_id())
  WITH CHECK (user_id = current_user_id());

-- SSO + templates + push scoped per workspace.
CREATE POLICY sso_providers_ws ON public.auth_sso_providers
  FOR ALL TO authenticated USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

CREATE POLICY sso_sessions_ws ON public.auth_sso_sessions
  FOR ALL TO authenticated USING (
    provider_id IN (SELECT id FROM public.auth_sso_providers
                    WHERE workspace_id = current_workspace_id())
  );

CREATE POLICY templates_ws ON public.comms_templates
  FOR ALL TO authenticated USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

CREATE POLICY push_devices_ws ON public.push_devices
  FOR ALL TO authenticated USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

CREATE POLICY push_messages_ws ON public.push_messages
  FOR ALL TO authenticated USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

COMMIT;
