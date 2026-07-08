-- =============================================================================
-- Ensure the Postgres roles Pluto needs:
--   anon             — unauthenticated bearer path
--   authenticated    — every signed-in user (super_admin / admin / user all
--                       collapse to this at the Postgres level; RLS uses
--                       auth.uid() + JWT claims for finer-grained checks)
--   service_role     — server-side/admin path (BYPASSRLS)
--   admin            — compatibility NOLOGIN group role for old containers,
--                       old dumps, or manual SQL that still references it.
--                       New Data API requests do NOT SET ROLE admin.
--
-- Idempotent. Safe to run against an existing prod cluster. Run as a
-- superuser (postgres) OR as the DB owner (POSTGRES_USER, e.g. `pluto`).
--
-- Usage on the VPS:
--   docker compose -f docker/docker-compose.yml exec -T postgres \
--     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     < deploy/ensure-pg-roles.sql
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin') THEN
    CREATE ROLE admin NOLOGIN;
  END IF;
END$$;

-- Grant membership so the connection user can SET LOCAL ROLE into the group
-- roles and so compatibility SQL referencing admin does not fail.
DO $$
DECLARE app_user text := current_user;
BEGIN
  EXECUTE format('GRANT anon, authenticated, service_role, admin TO %I', app_user);
END$$;

-- Report so you can eyeball the result.
SELECT rolname, rolcanlogin, rolbypassrls
FROM pg_roles
WHERE rolname IN ('anon','authenticated','service_role')
   OR rolname = 'admin'
ORDER BY rolname;
