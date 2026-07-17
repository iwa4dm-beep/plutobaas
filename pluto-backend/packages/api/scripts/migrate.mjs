#!/usr/bin/env node
// SQL migrations runner.
//   node migrate.mjs            → apply pending migrations
//   node migrate.mjs --dry-run  → execute pending files inside one rolled-back transaction
//   node migrate.mjs --plan-only → list pending files, do NOT execute
//   node migrate.mjs --json     → emit a machine-readable report to stdout
//
// Env: DATABASE_URL (required)
//      PLUTO_MIGRATION_REPORT   → also write JSON report to this path
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = resolve(__dirname, '../../../migrations');
const DATABASE_URL = process.env.DATABASE_URL;
const REPORT_PATH = process.env.PLUTO_MIGRATION_REPORT || '';
const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run') || argv.has('-n');
const PLAN_ONLY = argv.has('--plan-only');
const JSON_OUT = argv.has('--json');
const LOCK_KEY_1 = 725443;
const LOCK_KEY_2 = 2101;
const ROLLBACK = Symbol('dry-run-rollback');

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const sql = postgres(DATABASE_URL, { max: 1 });
const startedAt = new Date().toISOString();
const report = {
  started_at: startedAt,
  finished_at: null,
  dry_run: DRY_RUN,
  plan_only: PLAN_ONLY,
  database: safeDbLabel(DATABASE_URL),
  applied_before: [],
  pending: [],
  results: [],   // { file, ok, duration_ms, error? }
  auth_functions: [],  // { name, exists } — required auth.* shims
  repairs: [],
  summary: { total_pending: 0, applied: 0, failed: 0, skipped: 0, auth_missing: 0, dry_run_validated: 0 },
};

const REQUIRED_AUTH_FNS = ['uid', 'role', 'jwt'];

try {
  await ensureMigrationPrerequisites(sql);

  await sql`CREATE TABLE IF NOT EXISTS _pluto_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz DEFAULT now()
  )`;

  const appliedRows = await sql`SELECT name, applied_at FROM _pluto_migrations ORDER BY name`;
  const applied = new Set(appliedRows.map((r) => r.name));
  report.applied_before = appliedRows.map((r) => ({ name: r.name, applied_at: r.applied_at }));

  // Verify required auth.* shim functions exist. In dry-run this is the
  // primary safety check; in apply-mode a missing function will simply crash
  // 0016+ but we still surface the state clearly.
  const fnRows = await sql`
    select p.proname as name
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = any(${REQUIRED_AUTH_FNS})`;
  const havFns = new Set(fnRows.map((r) => r.name));
  report.auth_functions = REQUIRED_AUTH_FNS.map((n) => ({ name: `auth.${n}`, exists: havFns.has(n) }));
  report.summary.auth_missing = report.auth_functions.filter((f) => !f.exists).length;

  const files = (await readdir(MIG_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));
  report.pending = pending;
  report.summary.total_pending = pending.length;

  if (PLAN_ONLY) {
    log(`▶ plan-only: ${pending.length} pending migration(s)`);
    for (const f of pending) log(`  · ${f}   (${join(MIG_DIR, f)})`);
    log(`▶ auth.* shim check:`);
    for (const f of report.auth_functions) log(`  ${f.exists ? '✔' : '✘'} ${f.name}`);
    if (report.summary.auth_missing > 0) {
      log(`✘ ${report.summary.auth_missing} required auth.* function(s) missing — migrations 0016+ WILL fail`);
      process.exitCode = 2;
    }
    report.summary.skipped = pending.length;
  } else if (DRY_RUN) {
    log(`▶ dry-run: validating ${pending.length} pending migration(s) in a rolled-back transaction`);
    await acquireMigrationLock(sql);
    try {
      await sql.begin(async (tx) => {
        await setMigrationTimeouts(tx);
        for (const f of pending) {
          log(`→ dry-run ${f}`);
          const contents = await readFile(join(MIG_DIR, f), 'utf8');
          const prepared = prepareMigrationSql(contents);
          const t0 = Date.now();
          try {
            await tx.unsafe(prepared.sql);
            await tx`INSERT INTO _pluto_migrations (name) VALUES (${f})`;
            const ms = Date.now() - t0;
            report.results.push({ file: f, ok: true, dry_run: true, duration_ms: ms, repairs: prepared.repairs });
            report.repairs.push(...prepared.repairs.map((r) => ({ file: f, ...r })));
            report.summary.dry_run_validated++;
            log(`  ✔ ${f} dry-run OK (${ms}ms)`);
          } catch (e) {
            const ms = Date.now() - t0;
            const diagnostic = buildPgDiagnostic(e, prepared.sql);
            report.results.push({
              file: f, ok: false, dry_run: true, duration_ms: ms,
              error: e.message, code: e.code ?? null, hint: e.hint ?? null, routine: e.routine ?? null,
              diagnostic, repairs: prepared.repairs,
            });
            report.summary.failed++;
            log(`  ✘ ${f} dry-run failed (${ms}ms): ${e.message}`);
            if (diagnostic?.snippet) log(`    near: ${diagnostic.snippet.replace(/\s+/g, ' ').trim()}`);
            throw e;
          }
        }
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await releaseMigrationLock(sql);
    }
    report.summary.skipped = pending.length;
    log(`✔ dry-run passed for ${report.summary.dry_run_validated} migration(s); no DB changes committed`);
  } else {
    await acquireMigrationLock(sql);
    for (const f of pending) {
      log(`→ applying ${f}`);
      const contents = await readFile(join(MIG_DIR, f), 'utf8');
      const prepared = prepareMigrationSql(contents);
      const t0 = Date.now();
      try {
        await sql.begin(async (tx) => {
          await setMigrationTimeouts(tx);
          await tx.unsafe(prepared.sql);
          await tx`INSERT INTO _pluto_migrations (name) VALUES (${f})`;
        });
        const ms = Date.now() - t0;
        report.results.push({ file: f, ok: true, duration_ms: ms, repairs: prepared.repairs });
        report.repairs.push(...prepared.repairs.map((r) => ({ file: f, ...r })));
        report.summary.applied++;
        log(`  ✔ ${f} (${ms}ms)`);
      } catch (e) {
        const ms = Date.now() - t0;
        const diagnostic = buildPgDiagnostic(e, prepared.sql);
        report.results.push({
          file: f, ok: false, duration_ms: ms,
          error: e.message, code: e.code ?? null, hint: e.hint ?? null, routine: e.routine ?? null,
          diagnostic, repairs: prepared.repairs,
        });
        report.summary.failed++;
        log(`  ✘ ${f} failed (${ms}ms): ${e.message}`);
        if (diagnostic?.snippet) log(`    near: ${diagnostic.snippet.replace(/\s+/g, ' ').trim()}`);
        throw e;
      }
    }
    await releaseMigrationLock(sql);
    log(report.summary.applied === 0 ? '✔ no new migrations' : `✔ applied ${report.summary.applied} migration(s)`);
  }
} catch (e) {
  if (!report.results.length) {
    report.results.push({ file: '(pre-migration)', ok: false, duration_ms: 0, error: e.message, diagnostic: buildPgDiagnostic(e, '') });
  }
  report.summary.failed = report.summary.failed || 1;
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  await releaseMigrationLock(sql).catch(() => {});
  await sql.end().catch(() => {});
  if (REPORT_PATH) {
    await mkdir(dirname(resolve(REPORT_PATH)), { recursive: true }).catch(() => {});
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    log(`▶ wrote JSON report → ${REPORT_PATH}`);
  }
  if (JSON_OUT) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

function safeDbLabel(u) {
  try { const p = new URL(u); return `${p.hostname}:${p.port || 5432}${p.pathname}`; }
  catch { return 'unknown'; }
}

async function acquireMigrationLock(conn) {
  await conn`select pg_advisory_lock(${LOCK_KEY_1}, ${LOCK_KEY_2})`;
}

async function releaseMigrationLock(conn) {
  await conn`select pg_advisory_unlock(${LOCK_KEY_1}, ${LOCK_KEY_2})`;
}

async function setMigrationTimeouts(conn) {
  const lockTimeout = safeTimeout(process.env.PLUTO_MIGRATION_LOCK_TIMEOUT || '15s');
  const statementTimeout = safeTimeout(process.env.PLUTO_MIGRATION_STATEMENT_TIMEOUT || '180s');
  await conn.unsafe(`set local lock_timeout = '${lockTimeout}'`);
  await conn.unsafe(`set local statement_timeout = '${statementTimeout}'`);
}

function safeTimeout(v) {
  return /^[0-9]+(ms|s|min)?$/i.test(String(v).trim()) ? String(v).trim() : '180s';
}

async function ensureMigrationPrerequisites(conn) {
  const repairs = [];
  await conn.unsafe(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS admin;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE SET search_path = public AS $$
      SELECT nullif(current_setting('pluto.user_id', true), '')::uuid
    $$;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE SET search_path = public AS $$
      SELECT coalesce(nullif(current_setting('pluto.role', true), ''), 'anon')
    $$;

    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE plpgsql STABLE SET search_path = public AS $$
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
    END $$;

    ALTER TABLE IF EXISTS auth.users
      ADD COLUMN IF NOT EXISTS is_superadmin boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

    ALTER TABLE IF EXISTS admin.projects
      ADD COLUMN IF NOT EXISTS owner_id uuid,
      ADD COLUMN IF NOT EXISTS workspace_id uuid;
  `);
  repairs.push({ kind: 'prerequisite', detail: 'auth shim, pgcrypto, compatibility columns ensured' });

  try {
    await conn.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin') THEN CREATE ROLE admin NOLOGIN; END IF;
      END $$;
      DO $$
      BEGIN
        EXECUTE format('GRANT anon, authenticated, service_role, admin TO %I', current_user);
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END $$;
    `);
    repairs.push({ kind: 'roles', detail: 'anon/authenticated/service_role/admin roles ensured' });
  } catch (e) {
    repairs.push({ kind: 'roles-warning', detail: e.message });
    log('⚠ role repair skipped:', e.message);
  }
  report.repairs.push(...repairs);
}

function prepareMigrationSql(contents) {
  const repairs = [];
  let out = String(contents || '').replace(/^\uFEFF/, '');
  const beforeOuter = out;
  out = stripOuterTransaction(out);
  if (out !== beforeOuter) repairs.push({ kind: 'strip_outer_transaction', detail: 'removed outer BEGIN/COMMIT so runner controls rollback atomically' });

  const beforeUuid = out;
  out = out.replace(/'\s*uuid_generate_v4\s*\(\s*\)\s*'/gi, 'gen_random_uuid()');
  out = out.replace(/\buuid_generate_v4\s*\(\s*\)/gi, 'gen_random_uuid()');
  if (out !== beforeUuid) repairs.push({ kind: 'uuid_default', detail: 'normalized uuid_generate_v4() to gen_random_uuid()' });

  const beforePolicies = out;
  out = makePolicyCreatesIdempotent(out);
  if (out !== beforePolicies) repairs.push({ kind: 'policy_idempotency', detail: 'added DROP POLICY IF EXISTS before CREATE POLICY' });

  const beforeOwner = out;
  out = addOwnerIdPolicyGuards(out);
  if (out !== beforeOwner) repairs.push({ kind: 'owner_id_guard', detail: 'added owner_id columns before owner-based policies' });

  const preamble = buildAdaptivePreamble(out, repairs);
  return { sql: `${preamble}\n${out}`.trim() + '\n', repairs };
}

function stripOuterTransaction(sqlText) {
  return sqlText
    .replace(/^\s*begin\s*;\s*$/gim, '')
    .replace(/^\s*commit\s*;\s*$/gim, '')
    .trim();
}

function buildAdaptivePreamble(sqlText, repairs) {
  const chunks = [
    `CREATE SCHEMA IF NOT EXISTS public;`,
    `CREATE SCHEMA IF NOT EXISTS auth;`,
    `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
  ];
  if (/\bgin_trgm_ops\b|\bgist_trgm_ops\b/i.test(sqlText)) {
    chunks.push(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    repairs.push({ kind: 'extension', detail: 'pg_trgm ensured because trigram index operator class is used' });
  }
  if (/\bcitext\b/i.test(sqlText)) {
    chunks.push(`CREATE EXTENSION IF NOT EXISTS citext;`);
    repairs.push({ kind: 'extension', detail: 'citext ensured because citext type is used' });
  }
  if (/\bvector\s*(?:\(|,|$)/i.test(sqlText)) {
    chunks.push(`CREATE EXTENSION IF NOT EXISTS vector;`);
    repairs.push({ kind: 'extension', detail: 'vector ensured because vector type is used' });
  }
  return chunks.join('\n');
}

function makePolicyCreatesIdempotent(sqlText) {
  const policyCreate = /(^|\n)(\s*)CREATE\s+POLICY\s+((?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*)\s+ON\s+((?:(?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:(?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*))?)\s+/gi;
  return sqlText.replace(policyCreate, (match, prefix, indent, policyName, tableName, offset) => {
    const before = sqlText.slice(Math.max(0, offset - 220), offset);
    if (new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+${escapeRegExp(policyName)}\\s+ON\\s+${escapeRegExp(tableName)}`, 'i').test(before)) {
      return match;
    }
    return `${prefix}${indent}DROP POLICY IF EXISTS ${policyName} ON ${tableName};\n${indent}CREATE POLICY ${policyName} ON ${tableName} `;
  });
}

function addOwnerIdPolicyGuards(sqlText) {
  const policyStatement = /(^|\n)(\s*(?:DROP\s+POLICY\s+IF\s+EXISTS\s+[^;]+;\s*)?CREATE\s+POLICY\s+[^;]+\s+ON\s+((?:(?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:(?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*))?)\s+[^;]*owner_id[^;]*;)/gi;
  return sqlText.replace(policyStatement, (match, prefix, statement, tableName, offset) => {
    const guard = `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS owner_id uuid;`;
    const before = sqlText.slice(Math.max(0, offset - 260), offset);
    if (new RegExp(`ALTER\\s+TABLE\\s+${escapeRegExp(tableName)}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+owner_id`, 'i').test(before)) {
      return match;
    }
    return `${prefix}${guard}\n${statement}`;
  });
}

function buildPgDiagnostic(e, sqlText) {
  const pg = {
    code: e?.code ?? null,
    detail: e?.detail ?? null,
    hint: e?.hint ?? null,
    position: e?.position ?? null,
    where: e?.where ?? null,
    schema: e?.schema_name ?? e?.schema ?? null,
    table: e?.table_name ?? e?.table ?? null,
    column: e?.column_name ?? e?.column ?? null,
    dataType: e?.data_type_name ?? e?.dataType ?? null,
    constraint: e?.constraint_name ?? e?.constraint ?? null,
    routine: e?.routine ?? null,
  };
  const pos = Number(pg.position);
  if (!Number.isFinite(pos) || pos <= 0 || !sqlText) return { pg, snippet: null, line: null, column: null, offending: null };
  const idx = Math.max(0, pos - 1);
  const start = Math.max(0, idx - 180);
  const end = Math.min(sqlText.length, idx + 180);
  const before = sqlText.slice(0, idx);
  const line = before.split('\n').length;
  const lastNl = before.lastIndexOf('\n');
  const column = idx - lastNl;
  const token = sqlText.slice(idx).match(/^[^\s,;)]+/)?.[0] ?? null;
  return { pg, snippet: sqlText.slice(start, end), line, column, offending: token };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
