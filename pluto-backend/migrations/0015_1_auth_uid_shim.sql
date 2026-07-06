-- Phase 15 — auth.uid() / auth.role() shims
--
-- Migrations 0016–0026 were originally authored assuming Supabase's built-in
-- `auth.uid()` and `auth.role()` helpers. This Pluto backend is a custom
-- Fastify + postgres.js stack; those functions don't exist here, so every
-- CREATE POLICY that references them fails with:
--   ERROR: function auth.uid() does not exist  (SQLSTATE 42883)
--
-- The API layer sets per-request GUCs (`pluto.user_id`, `pluto.role`) via
-- `set_config(...)` on the connection before running user queries — same
-- pattern as backend/apps/server. These shims bridge to that convention so
-- the existing 0016–0026 policies work verbatim.
--
-- Safe to rerun. Returns NULL when no GUC is set (RLS then denies the row,
-- which is the intended default).

create schema if not exists auth;

create or replace function auth.uid() returns uuid
  language sql stable
  set search_path = public
as $$
  select nullif(current_setting('pluto.user_id', true), '')::uuid
$$;

create or replace function auth.role() returns text
  language sql stable
  set search_path = public
as $$
  select coalesce(nullif(current_setting('pluto.role', true), ''), 'anon')
$$;

-- Convenience: `auth.jwt()` sometimes referenced by future policies.
create or replace function auth.jwt() returns jsonb
  language sql stable
  set search_path = public
as $$
  select nullif(current_setting('pluto.jwt', true), '')::jsonb
$$;
