-- Idempotent role bootstrap. Runs only on a first-init empty data dir
-- (postgres-alpine executes files in /docker-entrypoint-initdb.d once).
-- Ensures the roles Pluto SQL & migrations expect always exist, even
-- when the cluster was created with a non-`postgres` superuser (we use
-- POSTGRES_USER=pluto).

DO $$
BEGIN
  -- Compat superuser: some scripts, dumps, and manual `psql -U postgres`
  -- sessions assume a `postgres` role exists.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres LOGIN SUPERUSER;
  END IF;

  -- Application roles used by the REST layer's SET LOCAL ROLE and by
  -- audit / admin migrations. NOLOGIN — these are group roles.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin') THEN
    CREATE ROLE admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END$$;

-- Let the app owner (POSTGRES_USER, typically `pluto`) SET ROLE into
-- the group roles so per-request SET LOCAL ROLE works.
DO $$
DECLARE app_user text := current_user;
BEGIN
  EXECUTE format('GRANT admin, authenticated, anon, service_role TO %I', app_user);
END$$;
