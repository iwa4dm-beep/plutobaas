#!/usr/bin/env node
// SQL migrations runner.
//   node migrate.mjs            → apply pending migrations
//   node migrate.mjs --dry-run  → list pending files, do NOT apply
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
const JSON_OUT = argv.has('--json');

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
  database: safeDbLabel(DATABASE_URL),
  applied_before: [],
  pending: [],
  results: [],   // { file, ok, duration_ms, error? }
  auth_functions: [],  // { name, exists } — required auth.* shims
  summary: { total_pending: 0, applied: 0, failed: 0, skipped: 0, auth_missing: 0 },
};

const REQUIRED_AUTH_FNS = ['uid', 'role', 'jwt'];

try {
  // Shim is created even in dry-run so /health/migrations reports honestly.
  // Wrapping in try lets dry-run continue against a read-only replica.
  try {
    await sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SET search_path = public
      AS $$ SELECT nullif(current_setting('pluto.user_id', true), '')::uuid $$;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE SET search_path = public
      AS $$ SELECT coalesce(nullif(current_setting('pluto.role', true), ''), 'anon') $$;
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE SET search_path = public
      AS $$ SELECT nullif(current_setting('pluto.jwt', true), '')::jsonb $$;
    `);
  } catch (e) {
    if (!DRY_RUN) throw e;
    log('⚠ skipping shim install (dry-run):', e.message);
  }

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

  if (DRY_RUN) {
    log(`▶ dry-run: ${pending.length} pending migration(s)`);
    for (const f of pending) log(`  · ${f}   (${join(MIG_DIR, f)})`);
    log(`▶ auth.* shim check:`);
    for (const f of report.auth_functions) log(`  ${f.exists ? '✔' : '✘'} ${f.name}`);
    if (report.summary.auth_missing > 0) {
      log(`✘ ${report.summary.auth_missing} required auth.* function(s) missing — migrations 0016+ WILL fail`);
      process.exitCode = 2;
    }
    report.summary.skipped = pending.length;
  } else {
    for (const f of pending) {
      log(`→ applying ${f}`);
      const contents = await readFile(join(MIG_DIR, f), 'utf8');
      const t0 = Date.now();
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(contents);
          await tx`INSERT INTO _pluto_migrations (name) VALUES (${f})`;
        });
        const ms = Date.now() - t0;
        report.results.push({ file: f, ok: true, duration_ms: ms });
        report.summary.applied++;
        log(`  ✔ ${f} (${ms}ms)`);
      } catch (e) {
        const ms = Date.now() - t0;
        report.results.push({
          file: f, ok: false, duration_ms: ms,
          error: e.message, code: e.code ?? null, hint: e.hint ?? null, routine: e.routine ?? null,
        });
        report.summary.failed++;
        log(`  ✘ ${f} failed (${ms}ms): ${e.message}`);
        throw e;
      }
    }
    log(report.summary.applied === 0 ? '✔ no new migrations' : `✔ applied ${report.summary.applied} migration(s)`);
  }
} catch (e) {
  if (!report.results.length) {
    report.results.push({ file: '(pre-migration)', ok: false, duration_ms: 0, error: e.message });
  }
  report.summary.failed = report.summary.failed || 1;
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
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
