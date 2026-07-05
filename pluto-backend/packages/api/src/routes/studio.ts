// Data Studio: table editor CRUD, foreign-key navigation, snippets, saved queries, CSV import/export, ERD.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
function assertIdent(v: string) { if (!SAFE_IDENT.test(v)) throw new Error(`invalid identifier: ${v}`); return v; }
function qi(v: string) { return `"${assertIdent(v).replace(/"/g, '""')}"`; }

export async function studioRoutes(app: FastifyInstance, cfg: Config) {
  const sql = getSql(cfg);

  // ---------- Schema browsing / ERD ----------
  app.get('/admin/v1/studio/tables', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ schema: z.string().default('public') }).parse(req.query);
    return sql`
      select table_schema as schema, table_name as name,
        (select count(*) from information_schema.columns c
         where c.table_schema = t.table_schema and c.table_name = t.table_name) as columns
      from information_schema.tables t
      where table_schema = ${q.schema} and table_type = 'BASE TABLE'
      order by table_name`;
  });

  app.get('/admin/v1/studio/columns', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ schema: z.string().default('public'), table: z.string() }).parse(req.query);
    assertIdent(q.schema); assertIdent(q.table);
    const cols = await sql<any[]>`
      select column_name as name, data_type, is_nullable, column_default, ordinal_position
      from information_schema.columns
      where table_schema = ${q.schema} and table_name = ${q.table}
      order by ordinal_position`;
    const pk = await sql<any[]>`
      select a.attname as name
      from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = (${q.schema + '.' + q.table})::regclass and i.indisprimary`;
    const fks = await sql<any[]>`
      select kcu.column_name, ccu.table_schema as ref_schema, ccu.table_name as ref_table, ccu.column_name as ref_column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = ${q.schema} and tc.table_name = ${q.table}`;
    return { columns: cols, primary_key: pk.map((r) => r.name), foreign_keys: fks };
  });

  app.get('/admin/v1/studio/erd', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ schema: z.string().default('public') }).parse(req.query);
    const tables = await sql<any[]>`select table_name as name from information_schema.tables where table_schema = ${q.schema} and table_type = 'BASE TABLE'`;
    const edges = await sql<any[]>`
      select tc.table_name as source, ccu.table_name as target, kcu.column_name, ccu.column_name as ref_column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = ${q.schema}`;
    return { schema: q.schema, tables, edges };
  });

  // ---------- Row editor ----------
  app.get('/admin/v1/studio/rows', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({
      schema: z.string().default('public'),
      table: z.string(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      order_by: z.string().optional(),
    }).parse(req.query);
    assertIdent(q.schema); assertIdent(q.table);
    const orderClause = q.order_by ? `order by ${qi(q.order_by)}` : '';
    const rows = await sql.unsafe(`select * from ${qi(q.schema)}.${qi(q.table)} ${orderClause} limit $1 offset $2`, [q.limit, q.offset]);
    const [count] = await sql.unsafe(`select count(*)::bigint as n from ${qi(q.schema)}.${qi(q.table)}`);
    return { rows, total: Number(count.n) };
  });

  app.post('/admin/v1/studio/rows', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({ schema: z.string().default('public'), table: z.string(), values: z.record(z.any()) }).parse(req.body);
    assertIdent(body.schema); assertIdent(body.table);
    const keys = Object.keys(body.values); keys.forEach(assertIdent);
    if (!keys.length) throw new Error('no values');
    const cols = keys.map(qi).join(',');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const params = keys.map((k) => body.values[k]);
    const rows = await sql.unsafe(`insert into ${qi(body.schema)}.${qi(body.table)} (${cols}) values (${placeholders}) returning *`, params);
    await logAudit(cfg, { actor_id: actor.userId, action: 'studio.row.insert', target: `${body.schema}.${body.table}` });
    reply.code(201).send(rows[0]);
  });

  app.patch('/admin/v1/studio/rows', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({
      schema: z.string().default('public'), table: z.string(),
      pk_column: z.string(), pk_value: z.any(),
      values: z.record(z.any()),
    }).parse(req.body);
    assertIdent(body.schema); assertIdent(body.table); assertIdent(body.pk_column);
    const keys = Object.keys(body.values); keys.forEach(assertIdent);
    if (!keys.length) throw new Error('no values');
    const setClause = keys.map((k, i) => `${qi(k)} = $${i + 1}`).join(',');
    const params = [...keys.map((k) => body.values[k]), body.pk_value];
    const rows = await sql.unsafe(
      `update ${qi(body.schema)}.${qi(body.table)} set ${setClause} where ${qi(body.pk_column)} = $${keys.length + 1} returning *`,
      params
    );
    await logAudit(cfg, { actor_id: actor.userId, action: 'studio.row.update', target: `${body.schema}.${body.table}` });
    return rows[0] ?? null;
  });

  app.delete('/admin/v1/studio/rows', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({ schema: z.string().default('public'), table: z.string(), pk_column: z.string(), pk_value: z.any() }).parse(req.body);
    assertIdent(body.schema); assertIdent(body.table); assertIdent(body.pk_column);
    await sql.unsafe(`delete from ${qi(body.schema)}.${qi(body.table)} where ${qi(body.pk_column)} = $1`, [body.pk_value]);
    await logAudit(cfg, { actor_id: actor.userId, action: 'studio.row.delete', target: `${body.schema}.${body.table}` });
    reply.code(204).send();
  });

  // ---------- CSV import/export ----------
  app.get('/admin/v1/studio/export.csv', async (req, reply) => {
    await requireAuth(req, cfg);
    const q = z.object({ schema: z.string().default('public'), table: z.string(), limit: z.coerce.number().int().max(100000).default(10000) }).parse(req.query);
    assertIdent(q.schema); assertIdent(q.table);
    const rows = await sql.unsafe(`select * from ${qi(q.schema)}.${qi(q.table)} limit $1`, [q.limit]);
    if (!rows.length) { reply.header('content-type', 'text/csv').send(''); return; }
    const cols = Object.keys(rows[0]);
    const esc = (v: any) => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const csv = [cols.join(','), ...rows.map((r: any) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    reply.header('content-type', 'text/csv').header('content-disposition', `attachment; filename="${q.table}.csv"`).send(csv);
  });

  app.post('/admin/v1/studio/import.csv', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({ schema: z.string().default('public'), table: z.string(), csv: z.string().min(1) }).parse(req.body);
    assertIdent(body.schema); assertIdent(body.table);
    const lines = body.csv.trim().split(/\r?\n/);
    const header = lines.shift()!.split(',').map((s) => s.trim());
    header.forEach(assertIdent);
    let inserted = 0;
    for (const line of lines) {
      const vals: string[] = []; let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
        else { if (c === ',') { vals.push(cur); cur = ''; } else if (c === '"' && cur === '') inQ = true; else cur += c; }
      }
      vals.push(cur);
      const placeholders = header.map((_, i) => `$${i + 1}`).join(',');
      await sql.unsafe(
        `insert into ${qi(body.schema)}.${qi(body.table)} (${header.map(qi).join(',')}) values (${placeholders})`,
        vals.map((v) => v === '' ? null : v)
      );
      inserted++;
    }
    await logAudit(cfg, { actor_id: actor.userId, action: 'studio.csv.import', target: `${body.schema}.${body.table}`, detail: { inserted } });
    return { inserted };
  });

  // ---------- Snippets library ----------
  app.get('/admin/v1/studio/snippets', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return sql`select * from admin.sql_snippets where project_id = ${q.project_id} order by updated_at desc`;
  });
  app.post('/admin/v1/studio/snippets', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(), name: z.string().min(1), sql: z.string().min(1),
      description: z.string().optional(), is_shared: z.boolean().default(false), tags: z.array(z.string()).default([]),
    }).parse(req.body);
    const [row] = await sql<any[]>`
      insert into admin.sql_snippets (project_id, owner_id, name, description, sql, is_shared, tags)
      values (${body.project_id}, ${actor.userId}, ${body.name}, ${body.description ?? null}, ${body.sql}, ${body.is_shared}, ${body.tags})
      returning *`;
    reply.code(201).send(row);
  });
  app.delete('/admin/v1/studio/snippets/:id', async (req, reply) => {
    await requireAuth(req, cfg);
    const { id } = req.params as any;
    await sql`delete from admin.sql_snippets where id = ${id}`;
    reply.code(204).send();
  });

  // ---------- Saved queries ----------
  app.get('/admin/v1/studio/queries', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return sql`select * from admin.saved_queries where project_id = ${q.project_id} order by created_at desc`;
  });
  app.post('/admin/v1/studio/queries', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(), name: z.string(), sql: z.string(), params: z.record(z.any()).default({}),
    }).parse(req.body);
    const [row] = await sql<any[]>`
      insert into admin.saved_queries (project_id, owner_id, name, sql, params)
      values (${body.project_id}, ${actor.userId}, ${body.name}, ${body.sql}, ${body.params})
      returning *`;
    reply.code(201).send(row);
  });
  app.post('/admin/v1/studio/queries/:id/run', async (req) => {
    await requireAuth(req, cfg);
    const { id } = req.params as any;
    const [q] = await sql<any[]>`select * from admin.saved_queries where id = ${id}`;
    if (!q) throw new Error('not found');
    // Read-only guard
    if (!/^\s*(select|with)\b/i.test(q.sql)) throw new Error('saved queries must be read-only');
    const rows = await sql.unsafe(q.sql);
    await sql`update admin.saved_queries set last_run_at = now() where id = ${id}`;
    return { rows, count: rows.length };
  });
  app.delete('/admin/v1/studio/queries/:id', async (req, reply) => {
    await requireAuth(req, cfg);
    const { id } = req.params as any;
    await sql`delete from admin.saved_queries where id = ${id}`;
    reply.code(204).send();
  });
}
