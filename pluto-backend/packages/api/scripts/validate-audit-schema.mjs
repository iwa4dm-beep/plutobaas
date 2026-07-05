#!/usr/bin/env node
// Validate admin.audit_log schema: required columns/types, FK, indexes.
// Exits non-zero with a detailed report if anything is missing.
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(2);
}

const REQUIRED_COLUMNS = {
  project_id: 'uuid',
  resource_type: 'text',
  resource_id: 'text',
  params: 'jsonb',
  result: 'text',
  duration_ms: 'integer',
  error_message: 'text',
  actor_id: 'uuid',
  action: 'text',
  created_at: 'timestamp with time zone',
};

const REQUIRED_INDEXES = [
  'audit_log_created_at_idx',
  'audit_log_project_idx',
  'audit_log_actor_idx',
  'audit_log_action_idx',
];

const REQUIRED_FK = {
  name: 'audit_log_project_fk',
  column: 'project_id',
  refTable: 'admin.projects',
  refColumn: 'id',
};

const sql = postgres(DATABASE_URL, { max: 1 });
const errors = [];
const warn = [];

function fail(msg) { errors.push(msg); }
function info(msg) { console.log(`  ${msg}`); }

try {
  console.log('▶ audit_log schema validation');

  // Table exists?
  const [tbl] = await sql`
    select 1 as ok from information_schema.tables
    where table_schema = 'admin' and table_name = 'audit_log'`;
  if (!tbl) {
    fail('table admin.audit_log does NOT exist');
    throw new Error('missing_table');
  }
  info('✔ admin.audit_log table exists');

  // Columns
  const cols = await sql`
    select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'admin' and table_name = 'audit_log'`;
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));

  for (const [name, expected] of Object.entries(REQUIRED_COLUMNS)) {
    const c = byName[name];
    if (!c) { fail(`column "${name}" MISSING (expected ${expected})`); continue; }
    if (c.data_type !== expected) {
      fail(`column "${name}" type mismatch: expected ${expected}, got ${c.data_type}`);
    } else {
      info(`✔ column ${name} :: ${c.data_type}`);
    }
  }

  // NOT NULL sanity for critical columns
  for (const name of ['resource_type', 'params', 'result']) {
    if (byName[name] && byName[name].is_nullable === 'YES') {
      warn.push(`column "${name}" is nullable — expected NOT NULL after 0006_governance`);
    }
  }

  // FK constraint
  const [fk] = await sql`
    select c.conname,
           pg_get_constraintdef(c.oid) as def,
           confrelid::regclass::text as ref_table
    from pg_constraint c
    where c.conrelid = 'admin.audit_log'::regclass
      and c.contype = 'f'
      and c.conname = ${REQUIRED_FK.name}`;
  if (!fk) {
    fail(
      `FK "${REQUIRED_FK.name}" MISSING on admin.audit_log(${REQUIRED_FK.column}) -> ${REQUIRED_FK.refTable}(${REQUIRED_FK.refColumn})`,
    );
  } else {
    info(`✔ FK ${fk.conname}: ${fk.def}`);
    if (fk.ref_table !== REQUIRED_FK.refTable) {
      fail(`FK ${fk.conname} references ${fk.ref_table}, expected ${REQUIRED_FK.refTable}`);
    }
  }

  // Indexes
  const idx = await sql`
    select indexname from pg_indexes
    where schemaname = 'admin' and tablename = 'audit_log'`;
  const have = new Set(idx.map((r) => r.indexname));
  for (const name of REQUIRED_INDEXES) {
    if (!have.has(name)) fail(`index "${name}" MISSING`);
    else info(`✔ index ${name}`);
  }
} catch (e) {
  if (e.message !== 'missing_table') fail(`unexpected error: ${e.message}`);
} finally {
  await sql.end();
}

if (warn.length) {
  console.log('\n⚠ warnings:');
  for (const w of warn) console.log(`  - ${w}`);
}

if (errors.length) {
  console.error('\n❌ audit_log schema validation FAILED:');
  for (const err of errors) console.error(`  - ${err}`);
  console.error(
    '\nHint: re-run migrations (`node scripts/migrate.mjs`) and see docs/UPGRADE-0006-audit-log.md.',
  );
  process.exit(1);
}

console.log('\n✅ audit_log schema OK');
