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

export type DryRunEntry = {
  version: string;
  name: string;
  reason: "pending" | "rolled_back" | "failed";
  statement_count: number;
  bytes: number;
  has_down: boolean;
  preview: string;              // first ~400 chars of SQL
};

export async function planPending(): Promise<DryRunEntry[]> {
  const entries = await listMigrations();
  const files = await readMigrationFiles();
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const plan: DryRunEntry[] = [];
  for (const e of entries) {
    if (!(e.status === "pending" || e.status === "rolled_back" || e.status === "failed")) continue;
    const file = byVersion.get(e.version);
    if (!file) continue;
    const stmts = file.upSql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    plan.push({
      version: file.version,
      name: file.name,
      reason: e.status as "pending" | "rolled_back" | "failed",
      statement_count: stmts.length,
      bytes: file.upSql.length,
      has_down: !!file.downSql,
      preview: file.upSql.slice(0, 400),
    });
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
