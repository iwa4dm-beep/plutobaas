-- =============================================================
-- Phase 14 · Communications module
-- -------------------------------------------------------------
-- Email + SMS message ledger and outbound webhook subscriptions.
-- All tables are workspace-scoped; the only exception is the
-- pool user (pluto_jobs), which is allowed to append delivery
-- rows on behalf of the retry queue.
--
-- Delivery pattern:
--   1. Client calls POST /comms/v1/email/send.
--   2. Row inserted into comms_email_messages (status='queued').
--   3. Background job (pluto_jobs) picks it up, calls provider,
--      writes back status + provider_message_id.
--   4. Webhooks fire on state change (delivered/failed/bounced).
-- =============================================================

CREATE TABLE IF NOT EXISTS public.comms_email_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  from_address        text NOT NULL,
  to_addresses        text[] NOT NULL CHECK (array_length(to_addresses, 1) BETWEEN 1 AND 50),
  cc_addresses        text[],
  bcc_addresses       text[],
  subject             text NOT NULL,
  body_text           text,
  body_html           text,
  headers             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sending','delivered','failed','bounced')),
  provider            text,             -- 'smtp' | 'resend' | 'ses' | 'postmark'
  provider_message_id text,
  error               text,
  attempts            int  NOT NULL DEFAULT 0,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX IF NOT EXISTS idx_comms_email_ws_created ON public.comms_email_messages (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comms_email_status     ON public.comms_email_messages (status) WHERE status IN ('queued','sending');

CREATE TABLE IF NOT EXISTS public.comms_sms_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  from_number         text NOT NULL,
  to_number           text NOT NULL,
  body                text NOT NULL CHECK (length(body) <= 1600),
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sending','delivered','failed','undelivered')),
  provider            text,             -- 'twilio' | 'messagebird' | 'log'
  provider_message_id text,
  error               text,
  attempts            int  NOT NULL DEFAULT 0,
  segments            int,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX IF NOT EXISTS idx_comms_sms_ws_created ON public.comms_sms_messages (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.comms_webhooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name            text NOT NULL,
  url             text NOT NULL CHECK (url ~ '^https?://'),
  events          text[] NOT NULL CHECK (array_length(events, 1) BETWEEN 1 AND 32),
  secret_hash     text NOT NULL,      -- argon2id( raw_secret )
  is_active       bool NOT NULL DEFAULT true,
  max_retries     int  NOT NULL DEFAULT 8 CHECK (max_retries BETWEEN 0 AND 24),
  timeout_ms      int  NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
  headers         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,
  disabled_reason text,
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_comms_webhooks_ws ON public.comms_webhooks (workspace_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.comms_webhook_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id     uuid NOT NULL REFERENCES public.comms_webhooks(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event          text NOT NULL,
  payload        jsonb NOT NULL,
  attempt        int  NOT NULL DEFAULT 1,
  status         text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivered','failed','abandoned')),
  request_headers  jsonb,
  response_status  int,
  response_headers jsonb,
  response_body    text,
  error          text,
  next_retry_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_comms_deliveries_hook       ON public.comms_webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comms_deliveries_ws_pending ON public.comms_webhook_deliveries (workspace_id, next_retry_at) WHERE status = 'pending';

-- ── Grants ──────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comms_email_messages     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comms_sms_messages       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comms_webhooks           TO authenticated;
GRANT SELECT, INSERT                  ON public.comms_webhook_deliveries TO authenticated;
GRANT ALL ON public.comms_email_messages, public.comms_sms_messages,
             public.comms_webhooks,       public.comms_webhook_deliveries TO service_role;

-- The retry worker runs as pluto_jobs (Phase 6). It needs full write on the
-- delivery ledger + status updates on the message tables, but NOT the ability
-- to enumerate workspace secrets.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pluto_jobs') THEN
    EXECUTE 'GRANT SELECT, UPDATE ON public.comms_email_messages, public.comms_sms_messages TO pluto_jobs';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.comms_webhook_deliveries TO pluto_jobs';
    EXECUTE 'GRANT SELECT ON public.comms_webhooks TO pluto_jobs';
  END IF;
END $$;

-- ── RLS ─────────────────────────────────────────────────────────
ALTER TABLE public.comms_email_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comms_sms_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comms_webhooks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comms_webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- Helper: current workspace comes from a request-scoped GUC set by the
-- server on every authenticated request (see lib/workspace-context.ts).
CREATE POLICY comms_email_ws_isolation ON public.comms_email_messages
  FOR ALL TO authenticated
  USING      (workspace_id = current_setting('pluto.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('pluto.workspace_id', true)::uuid);

CREATE POLICY comms_sms_ws_isolation ON public.comms_sms_messages
  FOR ALL TO authenticated
  USING      (workspace_id = current_setting('pluto.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('pluto.workspace_id', true)::uuid);

CREATE POLICY comms_webhooks_ws_isolation ON public.comms_webhooks
  FOR ALL TO authenticated
  USING      (workspace_id = current_setting('pluto.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('pluto.workspace_id', true)::uuid);

CREATE POLICY comms_deliveries_ws_read ON public.comms_webhook_deliveries
  FOR SELECT TO authenticated
  USING (workspace_id = current_setting('pluto.workspace_id', true)::uuid);

-- Only the retry worker (pluto_jobs) or admins may write delivery rows.
CREATE POLICY comms_deliveries_admin_write ON public.comms_webhook_deliveries
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── updated_at trigger for email ──
CREATE OR REPLACE FUNCTION public.comms_email_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comms_email_touch ON public.comms_email_messages;
CREATE TRIGGER trg_comms_email_touch
  BEFORE UPDATE ON public.comms_email_messages
  FOR EACH ROW EXECUTE FUNCTION public.comms_email_touch();
