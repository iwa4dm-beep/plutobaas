-- Pluto BaaS — root superadmin auto-promotion
--
-- The API boot process writes PLUTO_ROOT_EMAIL into admin.runtime_config.
-- This trigger makes the configured email superadmin even when the account
-- is created after the API starts.

CREATE TABLE IF NOT EXISTS admin.runtime_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION admin.auto_promote_root_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = admin, auth, public
AS $$
DECLARE
  root_email text;
BEGIN
  SELECT value INTO root_email
  FROM admin.runtime_config
  WHERE key = 'root_email';

  IF root_email IS NOT NULL AND lower(NEW.email) = lower(root_email) THEN
    NEW.is_superadmin := true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_promote_root_user ON auth.users;
CREATE TRIGGER trg_auto_promote_root_user
BEFORE INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW
EXECUTE FUNCTION admin.auto_promote_root_user();