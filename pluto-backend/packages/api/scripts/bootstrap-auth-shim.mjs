#!/usr/bin/env node
// Idempotent bootstrap — ensures the `auth.*` compatibility shim exists in
// the database BEFORE the API starts and BEFORE any migration runs. Safe to
// re-run on every boot: all statements use CREATE OR REPLACE / IF NOT EXISTS.
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ bootstrap-auth-shim: DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

try {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS auth;

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      SET search_path = public
    AS $$
      SELECT nullif(current_setting('pluto.user_id', true), '')::uuid
    $$;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE
      SET search_path = public
    AS $$
      SELECT coalesce(nullif(current_setting('pluto.role', true), ''), 'anon')
    $$;

    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
      LANGUAGE plpgsql STABLE
      SET search_path = public
    AS $$
    DECLARE raw text;
    BEGIN
      raw := nullif(current_setting('pluto.jwt', true), '');
      IF raw IS NULL THEN
        raw := nullif(current_setting('request.jwt.claims', true), '');
      END IF;
      IF raw IS NULL OR btrim(raw) = '' THEN
        RETURN '{}'::jsonb;
      END IF;
      RETURN raw::jsonb;
    EXCEPTION WHEN others THEN
      RETURN '{}'::jsonb;
    END
    $$;
  `);

  // Smoke-test: prove auth.uid() is actually callable.
  const [row] = await sql`SELECT auth.uid() IS NULL AS ok`;
  if (!row?.ok && row?.ok !== false) {
    throw new Error('auth.uid() smoke-test returned unexpected result');
  }
  console.log('✔ auth.* shim bootstrapped (auth.uid / auth.role / auth.jwt)');
} catch (e) {
  console.error('❌ bootstrap-auth-shim failed:', e.message);
  process.exit(1);
} finally {
  await sql.end();
}
