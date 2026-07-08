// /admin/v1/dbio/* — Database Import / Export & External Connection surface.
//
// Superadmin-only. Provides:
//   • connections/*   — save + test creds for external MySQL/Postgres/SQLite
//   • import/schema   — apply a .sql DDL file
//   • import/dump     — apply a full dump (MySQL auto-converted to PG)
//   • import/csv      — CSV → table (append or create)
//   • import/mysql-live — pull directly from a saved MySQL connection
//   • jobs/*          — poll import progress
//   • export/*        — dump the local Postgres back out (SQL or MySQL-flavour)
//
// All heavy work runs as background jobs recorded in admin.import_jobs so the
// UI can poll for progress instead of holding an HTTP connection open for
// minutes on multi-hundred-MB dumps.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';
import {
  splitSqlStatements,
  convertMysqlStatement,
  detectDialect,
} from '../dbio/mysql-to-pg.js';

// ────────────────────────────── helpers ────────────────────────────────────

// Access gate for /admin/v1/dbio/*:
//   - superadmin                                    → full
//   - service_role                                  → full
//   - user with admin.dbio_grants.access = 'admin'  → full
//   - user with admin.dbio_grants.access = 'reader' → read-only routes only
//   - workspace API token with scope 'dbio:admin'   → full
//   - workspace API token with scope 'dbio:read'    → read-only
async function requireDbioAccess(req: any, cfg: Config, need: 'reader' | 'admin' = 'admin') {
  const h = String(req.headers.authorization ?? '');
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';

  // Workspace API tokens start with `plt_` — check scope directly.
  if (bearer.startsWith('plt_')) {
    const { createHash } = await import('node:crypto');
    const sql = getSql(cfg);
    const [tok] = await sql<any[]>`
      select scopes, revoked_at, expires_at from admin.workspace_tokens
      where token_hash = ${createHash('sha256').update(bearer).digest('hex')} limit 1`;
    if (!tok || tok.revoked_at || (tok.expires_at && new Date(tok.expires_at) < new Date())) {
      const e: any = new Error('invalid token'); e.statusCode = 401; throw e;
    }
    const scopes: string[] = tok.scopes ?? [];
    const ok = scopes.includes('*')
      || (need === 'admin' ? scopes.includes('dbio:admin') : scopes.includes('dbio:admin') || scopes.includes('dbio:read'));
    if (!ok) { const e: any = new Error(`dbio:${need} scope required`); e.statusCode = 403; throw e; }
    return { userId: null as string | null, viaToken: true };
  }

  // Session-based (JWT) — superadmin or grant row
  const actor = await requireAuth(req, cfg);
  if (actor.isSuperadmin || actor.role === 'service_role') return { userId: actor.userId, viaToken: false };
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`select access from admin.dbio_grants where user_id = ${actor.userId}`;
  if (!row) { const e: any = new Error('dbio access required (superadmin or admin.dbio_grants entry)'); e.statusCode = 403; throw e; }
  if (need === 'admin' && row.access !== 'admin') {
    const e: any = new Error('dbio admin access required'); e.statusCode = 403; throw e;
  }
  return { userId: actor.userId, viaToken: false };
}

// Only superadmins can manage the grants list itself.
async function requireGrantAdmin(req: any, cfg: Config) {
  const actor = await requireAuth(req, cfg);
  if (!(actor.isSuperadmin || actor.role === 'service_role')) {
    const e: any = new Error('superadmin required to manage dbio grants'); e.statusCode = 403; throw e;
  }
  return actor;
}

function encKey(): string {
  const k = process.env.DBIO_ENC_KEY;
  if (!k || k.length < 16) {
    const e: any = new Error('DBIO_ENC_KEY env var missing (min 16 chars) — set it in the API container');
    e.statusCode = 500; throw e;
  }
  return k;
}

async function readMultipartToString(req: any): Promise<{ filename: string; body: string; size: number }> {
  // @fastify/multipart is registered at server bootstrap. This helper streams
  // the first file part into memory as UTF-8 (dumps are text). For >500MB
  // files the caller should chunk-upload instead — we cap here defensively.
  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === 'file') {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of part.file) {
        total += chunk.length;
        if (total > 500 * 1024 * 1024) {
          const e: any = new Error('file too large (500 MB max)'); e.statusCode = 413; throw e;
        }
        chunks.push(chunk);
      }
      let buf = Buffer.concat(chunks);
      // .gz support
      if (part.filename.endsWith('.gz')) {
        const zlib = await import('node:zlib');
        buf = zlib.gunzipSync(buf);
      }
      return { filename: part.filename, body: buf.toString('utf8'), size: buf.length };
    }
  }
  const e: any = new Error('no file uploaded'); e.statusCode = 400; throw e;
}

async function createJob(cfg: Config, actor: any, row: {
  kind: string; source_dialect: string; target_schema: string;
  file_name?: string; file_bytes?: number; connection_id?: string | null;
}): Promise<string> {
  const sql = getSql(cfg);
  const [j] = await sql<any[]>`
    insert into admin.import_jobs (kind, source_dialect, target_schema, file_name, file_bytes, connection_id, created_by, status, started_at)
    values (${row.kind}, ${row.source_dialect}, ${row.target_schema}, ${row.file_name ?? null}, ${row.file_bytes ?? null}, ${row.connection_id ?? null}, ${actor.userId}, 'running', now())
    returning id`;
  return j.id;
}

async function updateJob(cfg: Config, id: string, patch: Record<string, any>) {
  const sql = getSql(cfg);
  const cols = Object.keys(patch);
  if (!cols.length) return;
  await sql`update admin.import_jobs set ${sql(patch)}, ${
    patch.status === 'success' || patch.status === 'failed' ? sql`finished_at = now()` : sql`id = id`
  } where id = ${id}`;
}

// ────────────────────────────── SQL importer ────────────────────────────────

async function runSqlImport(
  cfg: Config, jobId: string, source: string, dialect: 'mysql' | 'postgres' | 'unknown',
  targetSchema: string, opts: { convertMysql: boolean; continueOnError: boolean },
) {
  const sql = getSql(cfg);
  const stmts = splitSqlStatements(source);
  let applied = 0, failed = 0;
  const logLines: string[] = [];

  await updateJob(cfg, jobId, { stmt_total: stmts.length });

  // Run in a single transaction unless the caller opted into continue-on-error.
  const runOne = async (raw: string) => {
    let stmt: string | null = raw;
    if (opts.convertMysql && dialect !== 'postgres') stmt = convertMysqlStatement(raw);
    if (!stmt) return;
    try {
      // Prefix search_path so unqualified names land in the target schema.
      await sql.unsafe(`set local search_path to "${targetSchema}", public; ${stmt}`);
      applied++;
    } catch (e: any) {
      failed++;
      logLines.push(`✗ [${e.code ?? '???'}] ${e.message}\n    → ${raw.slice(0, 200)}`);
      if (!opts.continueOnError) throw e;
    }
  };

  try {
    if (opts.continueOnError) {
      // Per-statement savepoints (best-effort — commits successful ones)
      for (const s of stmts) {
        try { await sql.begin(async (tx: any) => { await tx.unsafe(`set local search_path to "${targetSchema}", public`); await runOne(s); }); } catch { /* per-statement failure captured */ }
      }
    } else {
      await sql.begin(async () => { for (const s of stmts) await runOne(s); });
    }
    await updateJob(cfg, jobId, {
      status: failed && !opts.continueOnError ? 'failed' : 'success',
      stmt_applied: applied, stmt_failed: failed,
      log: logLines.join('\n').slice(0, 200_000),
    });
  } catch (e: any) {
    await updateJob(cfg, jobId, {
      status: 'failed', stmt_applied: applied, stmt_failed: failed,
      log: logLines.join('\n').slice(0, 200_000),
      error_message: e.message,
    });
  }
}

// ────────────────────────────── CSV importer ────────────────────────────────

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { cur.push(cell); cell = ''; }
      else if (c === '\n') { cur.push(cell); cell = ''; rows.push(cur); cur = []; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || cur.length) { cur.push(cell); rows.push(cur); }
  const header = rows.shift() ?? [];
  return { header, rows: rows.filter((r) => r.some((v) => v.length)) };
}

async function runCsvImport(
  cfg: Config, jobId: string, csv: string, schema: string, table: string,
  opts: { createTable: boolean; truncate: boolean },
) {
  const sql = getSql(cfg);
  try {
    const { header, rows } = parseCsv(csv);
    if (!header.length) throw new Error('empty header');

    const safe = (s: string) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
      return `"${s}"`;
    };
    const qtbl = `${safe(schema)}.${safe(table)}`;

    if (opts.createTable) {
      const cols = header.map((h) => `${safe(h)} text`).join(', ');
      await sql.unsafe(`create table if not exists ${qtbl} (${cols})`);
      await sql.unsafe(`grant select, insert, update, delete on ${qtbl} to authenticated`);
    }
    if (opts.truncate) await sql.unsafe(`truncate ${qtbl}`);

    const colList = header.map(safe).join(',');
    let inserted = 0;
    // Batch inserts, 500 rows at a time
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const values: any[] = [];
      const placeholders = batch.map((r, ri) => {
        return '(' + header.map((_, ci) => `$${ri * header.length + ci + 1}`).join(',') + ')';
      }).join(',');
      for (const r of batch) for (let c = 0; c < header.length; c++) values.push(r[c] ?? null);
      await sql.unsafe(`insert into ${qtbl} (${colList}) values ${placeholders}`, values);
      inserted += batch.length;
      await updateJob(cfg, jobId, { rows_inserted: inserted, stmt_applied: inserted });
    }

    await updateJob(cfg, jobId, {
      status: 'success', stmt_total: rows.length, stmt_applied: rows.length,
      rows_inserted: inserted,
      log: `Imported ${inserted} rows into ${qtbl}`,
    });
  } catch (e: any) {
    await updateJob(cfg, jobId, { status: 'failed', error_message: e.message });
  }
}

// ────────────────────────────── routes ──────────────────────────────────────

export async function dbioRoutes(app: FastifyInstance, cfg: Config) {
  // Health probe
  app.get('/admin/v1/dbio/health', async () => ({ ok: true, service: 'dbio' }));

  // ── connections ──────────────────────────────────────────────────────────
  const connBody = z.object({
    name: z.string().min(1).max(80),
    dialect: z.enum(['postgres', 'mysql', 'mariadb', 'sqlite']),
    host: z.string().optional(),
    port: z.number().int().optional(),
    database_name: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    ssl: z.boolean().optional().default(false),
    options: z.record(z.any()).optional().default({}),
  });

  app.get('/admin/v1/dbio/connections', async (req, reply) => {
    await requireSuperadmin(req, cfg);
    const sql = getSql(cfg);
    const rows = await sql<any[]>`
      select id, name, dialect, host, port, database_name, username, ssl, options_json,
             created_at, last_tested_at, last_test_ok, last_test_error
      from admin.db_connections order by created_at desc`;
    return reply.send({ connections: rows });
  });

  app.post('/admin/v1/dbio/connections', async (req, reply) => {
    const actor = await requireSuperadmin(req, cfg);
    const b = connBody.parse(req.body);
    const sql = getSql(cfg);
    const key = encKey();
    const [row] = await sql<any[]>`
      insert into admin.db_connections
        (name, dialect, host, port, database_name, username, password_enc, ssl, options_json, created_by)
      values
        (${b.name}, ${b.dialect}, ${b.host ?? null}, ${b.port ?? null}, ${b.database_name ?? null},
         ${b.username ?? null},
         ${b.password ? sql`pgp_sym_encrypt(${b.password}, ${key})` : null},
         ${b.ssl}, ${sql.json(b.options)}, ${actor.userId})
      returning id, name, dialect, host, port, database_name, username, ssl, created_at`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: null,
      action: 'dbio.connection.create', resource_type: 'db_connection',
      resource_id: row.id, params: { name: b.name, dialect: b.dialect },
      result: 'ok',
    });
    return reply.send(row);
  });

  app.delete('/admin/v1/dbio/connections/:id', async (req: any, reply) => {
    const actor = await requireSuperadmin(req, cfg);
    const sql = getSql(cfg);
    await sql`delete from admin.db_connections where id = ${req.params.id}`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: null,
      action: 'dbio.connection.delete', resource_type: 'db_connection',
      resource_id: req.params.id, params: {}, result: 'ok',
    });
    return reply.send({ ok: true });
  });

  app.post('/admin/v1/dbio/connections/test', async (req, reply) => {
    await requireSuperadmin(req, cfg);
    const b = connBody.partial({ name: true }).parse(req.body);
    try {
      if (b.dialect === 'postgres') {
        const { Client } = await import('pg');
        const client = new Client({
          host: b.host, port: b.port, database: b.database_name,
          user: b.username, password: b.password, ssl: b.ssl ? { rejectUnauthorized: false } : undefined,
          connectionTimeoutMillis: 5000,
        });
        await client.connect(); await client.query('select 1'); await client.end();
      } else if (b.dialect === 'mysql' || b.dialect === 'mariadb') {
        let mysql: any;
        try { mysql = await import('mysql2/promise'); }
        catch { return reply.code(501).send({ ok: false, error: 'mysql2 driver not installed on API container. Run: docker exec <api> npm i mysql2 && restart' }); }
        const conn = await mysql.createConnection({
          host: b.host, port: b.port, database: b.database_name,
          user: b.username, password: b.password, ssl: b.ssl ? {} : undefined,
          connectTimeout: 5000,
        });
        await conn.query('select 1'); await conn.end();
      } else {
        return reply.send({ ok: false, error: 'sqlite test requires a file path (not supported over network)' });
      }
      return reply.send({ ok: true });
    } catch (e: any) {
      return reply.send({ ok: false, error: e.message });
    }
  });

  // ── file imports ─────────────────────────────────────────────────────────
  // multipart/form-data: file=<the sql>, plus query params for schema/mode
  app.post('/admin/v1/dbio/import/dump', async (req: any, reply) => {
    const actor = await requireSuperadmin(req, cfg);
    if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart/form-data required (field: file)' });
    const targetSchema = String(req.query?.schema ?? 'public');
    const dialectOverride = req.query?.dialect ? String(req.query.dialect) : null;
    const continueOnError = String(req.query?.continueOnError ?? 'false') === 'true';
    const { filename, body, size } = await readMultipartToString(req);
    const dialect = (dialectOverride as any) || detectDialect(body);
    const jobId = await createJob(cfg, actor, {
      kind: 'dump', source_dialect: dialect === 'unknown' ? 'mysql' : dialect,
      target_schema: targetSchema, file_name: filename, file_bytes: size,
    });
    // fire and forget — client polls /jobs/:id
    void runSqlImport(cfg, jobId, body, dialect, targetSchema, { convertMysql: true, continueOnError });
    return reply.send({ job_id: jobId });
  });

  app.post('/admin/v1/dbio/import/schema', async (req: any, reply) => {
    const actor = await requireSuperadmin(req, cfg);
    if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart/form-data required' });
    const targetSchema = String(req.query?.schema ?? 'public');
    const { filename, body, size } = await readMultipartToString(req);
    const dialect = detectDialect(body);
    const jobId = await createJob(cfg, actor, {
      kind: 'schema', source_dialect: dialect === 'unknown' ? 'postgres' : dialect,
      target_schema: targetSchema, file_name: filename, file_bytes: size,
    });
    void runSqlImport(cfg, jobId, body, dialect, targetSchema, { convertMysql: true, continueOnError: false });
    return reply.send({ job_id: jobId });
  });

  app.post('/admin/v1/dbio/import/csv', async (req: any, reply) => {
    const actor = await requireSuperadmin(req, cfg);
    if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart/form-data required' });
    const targetSchema = String(req.query?.schema ?? 'public');
    const table = String(req.query?.table ?? '');
    if (!table) return reply.code(400).send({ error: 'query param `table` required' });
    const createTable = String(req.query?.create ?? 'true') === 'true';
    const truncate = String(req.query?.truncate ?? 'false') === 'true';
    const { filename, body, size } = await readMultipartToString(req);
    const jobId = await createJob(cfg, actor, {
      kind: 'csv', source_dialect: 'csv',
      target_schema: targetSchema, file_name: filename, file_bytes: size,
    });
    void runCsvImport(cfg, jobId, body, targetSchema, table, { createTable, truncate });
    return reply.send({ job_id: jobId });
  });

  // ── jobs ─────────────────────────────────────────────────────────────────
  app.get('/admin/v1/dbio/jobs', async (req, reply) => {
    await requireSuperadmin(req, cfg);
    const sql = getSql(cfg);
    const rows = await sql`select id, kind, source_dialect, target_schema, file_name, file_bytes,
      status, stmt_total, stmt_applied, stmt_failed, rows_inserted, error_message,
      created_at, started_at, finished_at
      from admin.import_jobs order by created_at desc limit 100`;
    return reply.send({ jobs: rows });
  });

  app.get('/admin/v1/dbio/jobs/:id', async (req: any, reply) => {
    await requireSuperadmin(req, cfg);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`select * from admin.import_jobs where id = ${req.params.id}`;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return reply.send(row);
  });

  // ── export ───────────────────────────────────────────────────────────────
  // Emits a lightweight pg_dump-style textual dump (schema + data) for the
  // requested tables. For full-fidelity dumps use the /admin/v1/backups
  // pg_dump-backed surface — this is meant for quick "download this table"
  // flows from the UI.
  app.get('/admin/v1/dbio/export/sql', async (req: any, reply) => {
    await requireSuperadmin(req, cfg);
    const schema = String(req.query?.schema ?? 'public');
    const table = String(req.query?.table ?? '');
    if (!table || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
      return reply.code(400).send({ error: 'schema/table required and must be valid identifiers' });
    }
    const sqlDb = getSql(cfg);
    const cols = await sqlDb<any[]>`
      select column_name, data_type from information_schema.columns
      where table_schema = ${schema} and table_name = ${table}
      order by ordinal_position`;
    if (!cols.length) return reply.code(404).send({ error: 'table not found' });
    const rows = await sqlDb.unsafe(`select * from "${schema}"."${table}"`);
    const colList = cols.map((c) => `"${c.column_name}"`).join(', ');
    const lines: string[] = [`-- Pluto dbio export ${schema}.${table}`, `-- ${new Date().toISOString()}`, ''];
    for (const r of rows as any[]) {
      const vals = cols.map((c) => {
        const v = r[c.column_name];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (v instanceof Date) return `'${v.toISOString()}'`;
        if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
        return `'${String(v).replace(/'/g, "''")}'`;
      }).join(', ');
      lines.push(`INSERT INTO "${schema}"."${table}" (${colList}) VALUES (${vals});`);
    }
    reply.header('content-type', 'application/sql');
    reply.header('content-disposition', `attachment; filename="${schema}_${table}.sql"`);
    return reply.send(lines.join('\n'));
  });
}
