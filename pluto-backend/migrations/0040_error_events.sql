-- 0040: persist error trace ring buffer to a durable table.
--
-- The in-memory buffer in observability/error-log.ts is bounded to ~2000
-- events and evicts on restart. This table is the long-term audit store:
-- every 4xx/5xx captured by the central error handler is fire-and-forget
-- INSERTed here.
--
-- Access is restricted to service_role / superadmin via the admin API;
-- rows can contain hint/detail/stack fragments and MUST NOT be exposed to
-- end users.

CREATE TABLE IF NOT EXISTS admin.error_events (
  trace_id     text PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  method       text NOT NULL,
  url          text NOT NULL,
  endpoint     text,                       -- normalized route (no query, no dynamic ids)
  status       int  NOT NULL,
  error        text NOT NULL,              -- e.g. 'ValidationError', 'InternalError'
  message      text NOT NULL,              -- friendly text (safe for operator UI)
  code         text,                       -- e.g. 'validation_failed', PG SQLSTATE
  tag          text NOT NULL,              -- e.g. 'validation', 'internal', 'client'
  severity     text NOT NULL CHECK (severity IN ('warn','error')),
  fields       jsonb,                      -- field-level validation errors
  hint         text,
  detail       text,
  actor_id     uuid,
  user_agent   text,
  ip           text,
  stack        text                        -- 5xx only; can be null
);

CREATE INDEX IF NOT EXISTS error_events_at_idx      ON admin.error_events (at DESC);
CREATE INDEX IF NOT EXISTS error_events_status_idx  ON admin.error_events (status, at DESC);
CREATE INDEX IF NOT EXISTS error_events_code_idx    ON admin.error_events (code, at DESC) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS error_events_tag_idx     ON admin.error_events (tag, at DESC);
CREATE INDEX IF NOT EXISTS error_events_endpoint_idx ON admin.error_events (endpoint, at DESC) WHERE endpoint IS NOT NULL;
CREATE INDEX IF NOT EXISTS error_events_actor_idx   ON admin.error_events (actor_id, at DESC) WHERE actor_id IS NOT NULL;

-- Retention: prune events older than 30 days via a lightweight helper.
-- The API server calls this opportunistically inside persistErrorEvent().
CREATE OR REPLACE FUNCTION admin.prune_error_events(older_than interval DEFAULT interval '30 days')
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE deleted int;
BEGIN
  DELETE FROM admin.error_events WHERE at < now() - older_than;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- Auth-only surface: no anon access. The API server uses service_role and
-- the admin schema is already off the exposed Data API allowlist.
GRANT ALL ON admin.error_events TO service_role;
