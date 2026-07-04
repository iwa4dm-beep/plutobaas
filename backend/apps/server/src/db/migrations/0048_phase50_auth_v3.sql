-- Phase 50 — Auth v3 (WebAuthn/passkeys, TOTP MFA v2, session risk scoring, device management)
BEGIN;

-- ---------------- WebAuthn / passkeys ----------------
CREATE TABLE IF NOT EXISTS public.av3_webauthn_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  credential_id  text NOT NULL UNIQUE,          -- base64url
  public_key     bytea NOT NULL,                -- COSE key
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  aaguid         text,
  friendly_name  text,
  backup_eligible boolean NOT NULL DEFAULT false,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS av3_wa_creds_user_idx ON public.av3_webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS public.av3_webauthn_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid,
  challenge    text NOT NULL,                   -- base64url random
  purpose      text NOT NULL CHECK (purpose IN ('register','authenticate')),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS av3_wa_ch_expiry_idx ON public.av3_webauthn_challenges(expires_at) WHERE consumed_at IS NULL;

-- ---------------- TOTP v2 (independent of Phase 15) ----------------
CREATE TABLE IF NOT EXISTS public.av3_totp_factors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  secret_b32     text NOT NULL,                 -- shared secret (base32)
  friendly_name  text,
  status         text NOT NULL DEFAULT 'unverified'
                 CHECK (status IN ('unverified','verified','revoked')),
  verified_at    timestamptz,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS av3_totp_user_idx ON public.av3_totp_factors(user_id);

CREATE TABLE IF NOT EXISTS public.av3_recovery_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  code_hash    text NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS av3_rc_user_idx ON public.av3_recovery_codes(user_id);

-- ---------------- Device management ----------------
CREATE TABLE IF NOT EXISTS public.av3_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  device_hash    text NOT NULL,                 -- sha256(ua|accept-lang|platform)
  label          text,
  user_agent     text,
  ip_last        inet,
  trusted        boolean NOT NULL DEFAULT false,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  UNIQUE (user_id, device_hash)
);
CREATE INDEX IF NOT EXISTS av3_dev_user_idx ON public.av3_devices(user_id);

CREATE TABLE IF NOT EXISTS public.av3_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  device_id      uuid REFERENCES public.av3_devices(id) ON DELETE SET NULL,
  ip             inet,
  risk_score     integer NOT NULL DEFAULT 0,
  step_up_ok     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
CREATE INDEX IF NOT EXISTS av3_sess_user_idx ON public.av3_sessions(user_id);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.av3_webauthn_credentials,
                                        public.av3_webauthn_challenges,
                                        public.av3_totp_factors,
                                        public.av3_recovery_codes,
                                        public.av3_devices,
                                        public.av3_sessions TO authenticated;
GRANT ALL ON public.av3_webauthn_credentials,
             public.av3_webauthn_challenges,
             public.av3_totp_factors,
             public.av3_recovery_codes,
             public.av3_devices,
             public.av3_sessions TO service_role;

ALTER TABLE public.av3_webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.av3_webauthn_challenges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.av3_totp_factors         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.av3_recovery_codes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.av3_devices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.av3_sessions             ENABLE ROW LEVEL SECURITY;

COMMIT;
