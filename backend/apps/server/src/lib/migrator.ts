// Migration runner + ledger.
//
// Filesystem is the source of truth: every `NNNN_name.sql` under
// db/migrations/ is a version. We compute sha256(file body) as the
// checksum. Ledger (public.schema_migrations) records what has run.
//
// Statuses:
//   applied     — checksum matches file, up-to-date
//   drift       — applied, but the file on disk has changed since
//   rolled_back — user rolled back, safe to re-run
//   failed      — last attempt errored, re-run allowed
//   pending     — file exists, no ledger row
//   missing     — ledger row exists but file is gone
//
// A migration may embed an inverse block for rollback:
//   -- +migrate down
//   drop table foo;

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "../db/migrations");

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

export type MigrationFile = {
  version: string;
  name: string;
  path: string;
  upSql: string;
  downSql: string | null;
  checksum: string;
};

export type MigrationRow = {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  applied_by: string;
  duration_ms: number;
  status: "applied" | "rolled_back" | "failed";
  error: string | null;
};

export type MigrationStatus =
  | "applied"
  | "pending"
  | "drift"
  | "rolled_back"
  | "failed"
  | "missing";

export type MigrationEntry = {
  version: string;
  name: string;
  status: MigrationStatus;
  file_checksum: string | null;
  db_checksum: string | null;
  applied_at: string | null;
  duration_ms: number | null;
  has_down: boolean;
  error: string | null;
};

function splitUpDown(body: string): { up: string; down: string | null } {
  const marker = /^\s*--\s*\+migrate\s+down\s*$/im;
  const m = body.match(marker);
  if (!m) return { up: body, down: null };
  const idx = body.indexOf(m[0]);
  return { up: body.slice(0, idx), down: body.slice(idx + m[0].length) };
}

export async function readMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR).catch(() => [] as string[]);
  const files = entries.filter((f) => /^\d+_.+\.sql$/i.test(f)).sort();
  return Promise.all(
    files.map(async (f) => {
      const p = path.join(MIGRATIONS_DIR, f);
      const body = await readFile(p, "utf8");
      const { up, down } = splitUpDown(body);
      const version = f.replace(/\.sql$/i, "");
      const name = version.replace(/^\d+_/, "");
      return {
        version,
        name,
        path: p,
        upSql: up,
        downSql: down,
        checksum: createHash("sha256").update(body).digest("hex"),
      };
    })
  );
}

async function ensureLedger() {
  await pool.query(`
    create table if not exists public.schema_migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now(),
      applied_by text not null default 'runner',
      duration_ms int not null default 0,
      status text not null default 'applied',
      down_sql text,
      error text
    )
  `);
}

export async function listMigrations(): Promise<MigrationEntry[]> {
  await ensureLedger();
  const files = await readMigrationFiles();
  const { rows } = await pool.query<MigrationRow & { down_sql: string | null }>(
    "select * from public.schema_migrations order by version"
  );
  const byVersion = new Map(rows.map((r) => [r.version, r]));
  const entries: MigrationEntry[] = [];

  for (const f of files) {
    const row = byVersion.get(f.version);
    let status: MigrationStatus;
    if (!row) status = "pending";
    else if (row.status === "failed") status = "failed";
    else if (row.status === "rolled_back") status = "rolled_back";
    else if (row.checksum !== f.checksum) status = "drift";
    else status = "applied";

    entries.push({
      version: f.version,
      name: f.name,
      status,
      file_checksum: f.checksum,
      db_checksum: row?.checksum ?? null,
      applied_at: row?.applied_at ?? null,
      duration_ms: row?.duration_ms ?? null,
      has_down: !!f.downSql || !!row?.down_sql,
      error: row?.error ?? null,
    });
    byVersion.delete(f.version);
  }
  // Ledger rows with no corresponding file — orphaned/missing
  for (const row of byVersion.values()) {
    entries.push({
      version: row.version,
      name: row.name,
      status: "missing",
      file_checksum: null,
      db_checksum: row.checksum,
      applied_at: row.applied_at,
      duration_ms: row.duration_ms,
      has_down: !!row.down_sql,
      error: row.error,
    });
  }
  return entries.sort((a, b) => a.version.localeCompare(b.version));
}

async function runOne(file: MigrationFile, actor: string, emit?: EmitFn): Promise<MigrationRow> {
  const client = await pool.connect();
  const started = Date.now();
  await emit?.("step", { version: file.version, phase: "start" });
  try {
    await client.query("begin");
    await client.query(file.upSql);
    const duration = Date.now() - started;
    const { rows } = await client.query<MigrationRow>(
      `insert into public.schema_migrations
         (version, name, checksum, applied_by, duration_ms, status, down_sql, error)
       values ($1,$2,$3,$4,$5,'applied',$6,null)
       on conflict (version) do update set
         checksum = excluded.checksum,
         applied_at = now(),
         applied_by = excluded.applied_by,
         duration_ms = excluded.duration_ms,
         status = 'applied',
         down_sql = excluded.down_sql,
         error = null
       returning *`,
      [file.version, file.name, file.checksum, actor, duration, file.downSql]
    );
    await client.query("commit");
    await emit?.("step", { version: file.version, phase: "done", duration_ms: duration });
    return rows[0];
  } catch (e) {
    await client.query("rollback").catch(() => {});
    const message = e instanceof Error ? e.message : String(e);
    await pool.query(
      `insert into public.schema_migrations
         (version, name, checksum, applied_by, duration_ms, status, error)
       values ($1,$2,$3,$4,$5,'failed',$6)
       on conflict (version) do update set
         status = 'failed', error = excluded.error, applied_at = now()`,
      [file.version, file.name, file.checksum, actor, Date.now() - started, message]
    );
    await emit?.("step", { version: file.version, phase: "failed", error: message });
    throw e;
  } finally {
    client.release();
  }
}

export type EmitFn = (event: string, payload: unknown) => void | Promise<void>;

export type StatementInfo = {
  index: number;
  kind: string;
  target: string | null;
  sql: string;
};

export type SchemaDiff = {
  added: string[];
  removed: string[];
  changed: string[];
};

export type DryRunEntry = {
  version: string;
  name: string;
  reason: "pending" | "rolled_back" | "failed";
  statement_count: number;
  bytes: number;
  has_down: boolean;
  preview: string;
  statements: StatementInfo[];
  diff: SchemaDiff;
  before_snapshot_size: number;
  after_snapshot_size: number;
  simulation_error: string | null;
};

function classify(sql: string, index: number): StatementInfo {
  const s = sql.trim();
  const kinds: Array<[RegExp, string]> = [
    [/^create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, "CREATE_TABLE"],
    [/^alter\s+table\s+(?:if\s+exists\s+)?([\w."]+)/i, "ALTER_TABLE"],
    [/^drop\s+table\s+(?:if\s+exists\s+)?([\w."]+)/i, "DROP_TABLE"],
    [/^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w."]+)/i, "CREATE_INDEX"],
    [/^drop\s+index\s+(?:if\s+exists\s+)?([\w."]+)/i, "DROP_INDEX"],
    [/^create\s+policy\s+([\w."]+)/i, "CREATE_POLICY"],
    [/^drop\s+policy\s+(?:if\s+exists\s+)?([\w."]+)/i, "DROP_POLICY"],
    [/^create\s+(?:or\s+replace\s+)?function\s+([\w."]+)/i, "CREATE_FUNCTION"],
    [/^create\s+(?:or\s+replace\s+)?trigger\s+([\w."]+)/i, "CREATE_TRIGGER"],
    [/^grant\s+/i, "GRANT"],
    [/^revoke\s+/i, "REVOKE"],
    [/^insert\s+into\s+([\w."]+)/i, "INSERT"],
    [/^update\s+([\w."]+)/i, "UPDATE"],
    [/^delete\s+from\s+([\w."]+)/i, "DELETE"],
    [/^create\s+type\s+([\w."]+)/i, "CREATE_TYPE"],
    [/^create\s+schema\s+([\w."]+)/i, "CREATE_SCHEMA"],
    [/^comment\s+on\s+/i, "COMMENT"],
  ];
  for (const [rx, kind] of kinds) {
    const m = s.match(rx);
    if (m) return { index, kind, target: m[1] ?? null, sql: s };
  }
  return { index, kind: "OTHER", target: null, sql: s };
}

function splitStatements(body: string): string[] {
  return body.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

const SNAPSHOT_SQL = `
  select 'table:'    || table_schema || '.' || table_name as k
    from information_schema.tables
   where table_schema not in ('pg_catalog','information_schema','pg_toast')
  union all
  select 'column:'   || table_schema || '.' || table_name || '.' || column_name
                     || ' ' || data_type
                     || (case when is_nullable='YES' then ' NULL' else ' NOT NULL' end)
    from information_schema.columns
   where table_schema not in ('pg_catalog','information_schema','pg_toast')
  union all
  select 'index:'    || schemaname || '.' || indexname
    from pg_indexes
   where schemaname not in ('pg_catalog','information_schema')
  union all
  select 'policy:'   || schemaname || '.' || tablename || '.' || policyname
    from pg_policies
  union all
  select 'function:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog','information_schema','pg_toast')
  union all
  select 'trigger:'  || n.nspname || '.' || c.relname || '.' || t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal
`;

async function snapshot(client: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ k: string }>(SNAPSHOT_SQL);
  return new Set(rows.map((r) => r.k));
}

function diffSets(before: Set<string>, after: Set<string>): SchemaDiff {
  const added: string[] = []; const removed: string[] = []; const changed: string[] = [];
  const key = (s: string) => {
    const i = s.indexOf(":");
    if (i < 0) return s;
    const prefix = s.slice(0, i);
    const rest = s.slice(i + 1);
    if (prefix === "column") return `${prefix}:${rest.split(" ")[0]}`;
    return s;
  };
  const b = new Map<string, string>(); const a = new Map<string, string>();
  for (const s of before) b.set(key(s), s);
  for (const s of after) a.set(key(s), s);
  for (const [k, v] of a) {
    const prev = b.get(k);
    if (prev === undefined) added.push(v);
    else if (prev !== v) changed.push(`${prev}  →  ${v}`);
  }
  for (const [k, v] of b) if (!a.has(k)) removed.push(v);
  added.sort(); removed.sort(); changed.sort();
  return { added, removed, changed };
}

function baseEntry(file: MigrationFile, reason: DryRunEntry["reason"]): DryRunEntry {
  const stmts = splitStatements(file.upSql);
  return {
    version: file.version,
    name: file.name,
    reason,
    statement_count: stmts.length,
    bytes: file.upSql.length,
    has_down: !!file.downSql,
    preview: file.upSql.slice(0, 400),
    statements: stmts.map((s, i) => classify(s, i)),
    diff: { added: [], removed: [], changed: [] },
    before_snapshot_size: 0,
    after_snapshot_size: 0,
    simulation_error: null,
  };
}

export async function planPending(): Promise<DryRunEntry[]> {
  const entries = await listMigrations();
  const files = await readMigrationFiles();
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const plan: DryRunEntry[] = [];
  for (const e of entries) {
    if (!(e.status === "pending" || e.status === "rolled_back" || e.status === "failed")) continue;
    const file = byVersion.get(e.version);
    if (!file) continue;
    plan.push(baseEntry(file, e.status as DryRunEntry["reason"]));
  }
  return plan;
}

// Simulate each pending migration inside a transaction that is ALWAYS
// rolled back — the DB is guaranteed unchanged. Attaches a before/after
// schema diff per entry.
export async function planPendingDetailed(): Promise<DryRunEntry[]> {
  const plan = await planPending();
  if (plan.length === 0) return plan;
  const files = await readMigrationFiles();
  const byVersion = new Map(files.map((f) => [f.version, f]));

  for (const entry of plan) {
    const file = byVersion.get(entry.version);
    if (!file) continue;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const before = await snapshot(client);
      try {
        await client.query(file.upSql);
        const after = await snapshot(client);
        entry.diff = diffSets(before, after);
        entry.before_snapshot_size = before.size;
        entry.after_snapshot_size = after.size;
      } catch (e) {
        entry.simulation_error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  }
  return plan;
}

export async function runPending(actor = "dashboard", emit?: EmitFn) {
  await ensureLedger();
  const entries = await listMigrations();
  const files = await readMigrationFiles();
  const filesByVersion = new Map(files.map((f) => [f.version, f]));
  const applied: string[] = [];
  const failed: { version: string; error: string }[] = [];

  const targets = entries.filter((e) => e.status === "pending" || e.status === "rolled_back" || e.status === "failed");
  await emit?.("run.start", { total: targets.length, versions: targets.map((t) => t.version) });

  for (const e of targets) {
    const file = filesByVersion.get(e.version);
    if (!file) continue;
    try {
      await runOne(file, actor, emit);
      applied.push(e.version);
    } catch (err) {
      failed.push({ version: e.version, error: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  await emit?.("run.done", { applied, failed });
  return { applied, failed };
}

export async function rerunOne(version: string, actor = "dashboard", emit?: EmitFn) {
  const files = await readMigrationFiles();
  const file = files.find((f) => f.version === version);
  if (!file) throw new Error(`no_file:${version}`);
  return runOne(file, actor, emit);
}

export async function rollback(version: string, actor = "dashboard", emit?: EmitFn) {
  await ensureLedger();
  const { rows } = await pool.query<MigrationRow & { down_sql: string | null }>(
    "select * from public.schema_migrations where version=$1",
    [version]
  );
  const row = rows[0];
  if (!row) throw new Error("not_applied");
  const files = await readMigrationFiles();
  const file = files.find((f) => f.version === version);
  const down = row.down_sql ?? file?.downSql ?? null;
  if (!down || !down.trim()) throw new Error("no_down_sql");

  await emit?.("rollback.start", { version });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(down);
    await client.query(
      `update public.schema_migrations
         set status='rolled_back', applied_at=now(), applied_by=$2, error=null
       where version=$1`,
      [version, actor]
    );
    await client.query("commit");
    await emit?.("rollback.done", { version });
    return { ok: true };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    await emit?.("rollback.failed", { version, error: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    client.release();
  }
}
