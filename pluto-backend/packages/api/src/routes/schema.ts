import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit, timed } from '../audit/logger.js';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const asIdent = (s: string) => {
  if (!IDENT.test(s)) throw Object.assign(new Error(`invalid identifier: ${s}`), { statusCode: 400 });
  return `"${s}"`;
};

const indexBody = z.object({
  project_id: z.string().uuid(),
  schema: z.string(),
  table: z.string(),
  name: z.string(),
  columns: z.array(z.string()).min(1),
  method: z.enum(['btree', 'gin', 'gist', 'hash', 'brin']).default('btree'),
  unique: z.boolean().optional().default(false),
  where: z.string().max(500).optional(),
});

const constraintBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('unique'),
    project_id: z.string().uuid(),
    schema: z.string(), table: z.string(), name: z.string(),
    columns: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal('check'),
    project_id: z.string().uuid(),
    schema: z.string(), table: z.string(), name: z.string(),
    expression: z.string().min(1).max(1000),
  }),
  z.object({
    type: z.literal('not_null'),
    project_id: z.string().uuid(),
    schema: z.string(), table: z.string(),
    column: z.string(),
  }),
  z.object({
    type: z.literal('foreign_key'),
    project_id: z.string().uuid(),
    schema: z.string(), table: z.string(), name: z.string(),
    columns: z.array(z.string()).min(1),
    ref_schema: z.string(), ref_table: z.string(),
    ref_columns: z.array(z.string()).min(1),
    on_delete: z.enum(['no action','cascade','set null','restrict']).optional().default('no action'),
  }),
]);

async function recordMigration(cfg: Config, projectId: string, actorId: string, name: string, upSql: string, downSql: string) {
  const sql = getSql(cfg);
  const version = BigInt(Date.now());
  const checksum = createHash('sha256').update(upSql).digest('hex').slice(0, 32);
  const [row] = await sql<any[]>`
    insert into admin.migrations (project_id, version, name, up_sql, down_sql, checksum, applied_at, applied_by, created_by)
    values (${projectId}, ${version}, ${name}, ${upSql}, ${downSql}, ${checksum}, now(), ${actorId}, ${actorId})
    returning id, version, name, applied_at`;
  return row;
}

export async function schemaRoutes(app: FastifyInstance, cfg: Config) {
  // -------- LIST --------
  app.get<{ Params: { schema: string; table: string } }>(
    '/admin/v1/schema/tables/:schema/:table/indexes',
    async (req, reply) => {
      await requireAuth(req, cfg);
      const sql = getSql(cfg);
      const rows = await sql`
        select indexname as name, indexdef as definition
          from pg_indexes
         where schemaname = ${req.params.schema} and tablename = ${req.params.table}
         order by indexname`;
      return reply.send(rows);
    });

  app.get<{ Params: { schema: string; table: string } }>(
    '/admin/v1/schema/tables/:schema/:table/constraints',
    async (req, reply) => {
      await requireAuth(req, cfg);
      const sql = getSql(cfg);
      const rows = await sql`
        select con.conname as name,
               case con.contype
                 when 'p' then 'primary_key'
                 when 'u' then 'unique'
                 when 'c' then 'check'
                 when 'f' then 'foreign_key'
                 when 'n' then 'not_null'
                 else con.contype::text end as type,
               pg_get_constraintdef(con.oid) as definition
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace ns on ns.oid = rel.relnamespace
         where ns.nspname = ${req.params.schema} and rel.relname = ${req.params.table}
         order by con.conname`;
      return reply.send(rows);
    });

  // -------- CREATE INDEX --------
  app.post('/admin/v1/schema/indexes', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = indexBody.parse(req.body);
    await requireProjectRole(cfg, body.project_id, actor, ['owner', 'admin']);

    const schema = asIdent(body.schema);
    const table  = asIdent(body.table);
    const idx    = asIdent(body.name);
    const cols   = body.columns.map(asIdent).join(', ');
    const unique = body.unique ? 'unique ' : '';
    const where  = body.where ? ` where ${body.where}` : '';
    const upSql   = `create ${unique}index ${idx} on ${schema}.${table} using ${body.method} (${cols})${where}`;
    const downSql = `drop index if exists ${schema}.${idx}`;

    const sql = getSql(cfg);
    const t = await timed(async () => { await sql.unsafe(upSql); });
    const migration = await recordMigration(cfg, body.project_id, actor.userId,
      `add_index_${body.name}`, upSql, downSql);
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: body.project_id,
      action: 'schema.index.create', resource_type: 'index', resource_id: body.name,
      params: { up: upSql, down: downSql }, result: 'ok', duration_ms: t.ms,
    });
    return reply.code(201).send({ ok: true, migration, up_sql: upSql, down_sql: downSql });
  });

  // -------- DROP INDEX --------
  app.delete<{ Querystring: { project_id: string; schema: string; name: string } }>(
    '/admin/v1/schema/indexes',
    async (req, reply) => {
      const actor = await requireAuth(req, cfg);
      const q = z.object({
        project_id: z.string().uuid(),
        schema: z.string(),
        name: z.string(),
      }).parse(req.query);
      await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin']);
      const sql = getSql(cfg);
      const upSql = `drop index ${asIdent(q.schema)}.${asIdent(q.name)}`;
      const t = await timed(async () => { await sql.unsafe(upSql); });
      const migration = await recordMigration(cfg, q.project_id, actor.userId,
        `drop_index_${q.name}`, upSql, `-- rebuild ${q.name} manually`);
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: q.project_id,
        action: 'schema.index.drop', resource_type: 'index', resource_id: q.name,
        params: { up: upSql }, result: 'ok', duration_ms: t.ms,
      });
      return reply.send({ ok: true, migration });
    });

  // -------- ADD CONSTRAINT --------
  app.post('/admin/v1/schema/constraints', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = constraintBody.parse(req.body);
    await requireProjectRole(cfg, body.project_id, actor, ['owner', 'admin']);

    const schema = asIdent(body.schema);
    const table  = asIdent(body.table);
    let upSql = '', downSql = '', resourceId = '';

    if (body.type === 'unique') {
      const cols = body.columns.map(asIdent).join(', ');
      upSql   = `alter table ${schema}.${table} add constraint ${asIdent(body.name)} unique (${cols})`;
      downSql = `alter table ${schema}.${table} drop constraint ${asIdent(body.name)}`;
      resourceId = body.name;
    } else if (body.type === 'check') {
      upSql   = `alter table ${schema}.${table} add constraint ${asIdent(body.name)} check (${body.expression})`;
      downSql = `alter table ${schema}.${table} drop constraint ${asIdent(body.name)}`;
      resourceId = body.name;
    } else if (body.type === 'not_null') {
      upSql   = `alter table ${schema}.${table} alter column ${asIdent(body.column)} set not null`;
      downSql = `alter table ${schema}.${table} alter column ${asIdent(body.column)} drop not null`;
      resourceId = `${body.table}.${body.column}.not_null`;
    } else {
      const cols     = body.columns.map(asIdent).join(', ');
      const refCols  = body.ref_columns.map(asIdent).join(', ');
      upSql   = `alter table ${schema}.${table} add constraint ${asIdent(body.name)} `
              + `foreign key (${cols}) references ${asIdent(body.ref_schema)}.${asIdent(body.ref_table)} (${refCols}) `
              + `on delete ${body.on_delete}`;
      downSql = `alter table ${schema}.${table} drop constraint ${asIdent(body.name)}`;
      resourceId = body.name;
    }

    const sql = getSql(cfg);
    const t = await timed(async () => { await sql.unsafe(upSql); });
    const migration = await recordMigration(cfg, body.project_id, actor.userId,
      `add_constraint_${resourceId}`, upSql, downSql);
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: body.project_id,
      action: `schema.constraint.${body.type}`, resource_type: 'constraint', resource_id: resourceId,
      params: { up: upSql, down: downSql }, result: 'ok', duration_ms: t.ms,
    });
    return reply.code(201).send({ ok: true, migration, up_sql: upSql, down_sql: downSql });
  });

  // -------- DROP CONSTRAINT --------
  app.delete('/admin/v1/schema/constraints', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({
      project_id: z.string().uuid(),
      schema: z.string(), table: z.string(), name: z.string(),
    }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);
    const upSql = `alter table ${asIdent(q.schema)}.${asIdent(q.table)} drop constraint ${asIdent(q.name)}`;
    const t = await timed(async () => { await sql.unsafe(upSql); });
    const migration = await recordMigration(cfg, q.project_id, actor.userId,
      `drop_constraint_${q.name}`, upSql, `-- recreate ${q.name} manually`);
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: q.project_id,
      action: 'schema.constraint.drop', resource_type: 'constraint', resource_id: q.name,
      params: { up: upSql }, result: 'ok', duration_ms: t.ms,
    });
    return reply.send({ ok: true, migration });
  });
}
