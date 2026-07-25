-- 0041: PII redaction rules + alert webhooks for trace observability.
--
-- Both tables live in the admin schema (off the exposed Data API allowlist)
-- and are only accessed via the API server using service_role. Rows can
-- contain regex patterns and webhook secrets that must NOT be exposed to
-- end users.

CREATE TABLE IF NOT EXISTS admin.pii_redaction_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- Regex applied to string fields; use POSIX ERE. Validated in the API
  -- layer before insert.
  pattern     text NOT NULL,
  -- Which columns to redact in: any subset of
  -- {message, hint, detail, stack, url, fields, user_agent, all}.
  applies_to  text[] NOT NULL DEFAULT ARRAY['all']::text[],
  replacement text NOT NULL DEFAULT '[REDACTED]',
  enabled     boolean NOT NULL DEFAULT true,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pii_rules_enabled_idx
  ON admin.pii_redaction_rules (enabled) WHERE enabled;
GRANT ALL ON admin.pii_redaction_rules TO service_role;

CREATE TABLE IF NOT EXISTS admin.alert_webhooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  url             text NOT NULL,
  -- Optional HMAC-SHA256 signing secret; sent as x-pluto-signature header.
  secret          text,
  -- Which alert tags to forward. Empty array = all.
  tag_filter      text[] NOT NULL DEFAULT ARRAY[]::text[],
  enabled         boolean NOT NULL DEFAULT true,
  failure_count   int NOT NULL DEFAULT 0,
  last_delivery_at timestamptz,
  last_error      text,
  last_status     int,
  created_at      timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON admin.alert_webhooks TO service_role;
