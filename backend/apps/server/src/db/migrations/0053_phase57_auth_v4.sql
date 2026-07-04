-- Phase 57 — Auth v4 (SAML SSO enterprise, SCIM provisioning, session isolation)
--
-- Runtime state lives in in-process libs so tests stay hermetic; this
-- migration ships the durable audit + provider tables for the pattern
-- established in earlier phases.

BEGIN;

CREATE TABLE IF NOT EXISTS public.auth4_saml_providers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  slug           text NOT NULL,
  display_name   text NOT NULL,
  entity_id      text NOT NULL,
  sso_url        text NOT NULL,
  x509_cert      text NOT NULL,
  signing_secret text NOT NULL,
  attr_email     text NOT NULL DEFAULT 'email',
  attr_name      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS auth4_saml_ws_idx ON public.auth4_saml_providers(workspace_id);

CREATE TABLE IF NOT EXISTS public.auth4_scim_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  external_id   text,
  user_name     text NOT NULL,
  display_name  text,
  active        boolean NOT NULL DEFAULT true,
  emails        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_name)
);

CREATE TABLE IF NOT EXISTS public.auth4_scim_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  external_id   text,
  display_name  text NOT NULL,
  members       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.auth4_sessions (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  user_email    text NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  ip            inet,
  revoked       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth4_sessions_ws_idx ON public.auth4_sessions(workspace_id);

CREATE TABLE IF NOT EXISTS public.auth4_audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  user_email    text,
  action        text NOT NULL,
  status        text NOT NULL CHECK (status IN ('ok','denied','error')),
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth4_audit_ws_ts_idx ON public.auth4_audit_events(workspace_id, created_at DESC);

-- Grants + RLS (per docs/security/core-tables-rls.md pattern)
REVOKE ALL ON public.auth4_saml_providers, public.auth4_scim_users, public.auth4_scim_groups,
              public.auth4_sessions, public.auth4_audit_events FROM PUBLIC, anon, authenticated;
GRANT ALL   ON public.auth4_saml_providers, public.auth4_scim_users, public.auth4_scim_groups,
              public.auth4_sessions, public.auth4_audit_events TO service_role;

ALTER TABLE public.auth4_saml_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth4_scim_users     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth4_scim_groups    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth4_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth4_audit_events   ENABLE ROW LEVEL SECURITY;

COMMIT;
