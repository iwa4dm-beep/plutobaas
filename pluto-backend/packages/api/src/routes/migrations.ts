import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit, timed } from '../audit/logger.js';

const createBody = z.object({
  project_id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  up_sql: z.string().min(1),
  down_sql: z.string().min(0).default(''),
});

const listQ = z.object({
  project_id: z.string().uuid().optional(),
  status: z.enum(['pending', 'applied', 'rolled_back']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

async function assertRole(cfg: Config, projectId: string | null | undefined, actor: any) {
  if (!projectId) {
    if (!(actor.isSuperadmin || actor.role === 'service_role')) {
      const e: any = new Error('Superadmin required for global migrations'); e.statusCode = 403; throw e;
    }
    return;
  }
  await requireProjectRole(cfg, projectId, actor, ['owner', 'admin']);
}

export async function migrationsRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/admin/v1/migrations', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const q = listQ.parse(req.query);
    const sql = getSql(cfg);
    const rows = await sql`
      select id, project_id, version, name, checksum,
             applied_at, applied_by, rolled_back_at, rolled_back_by,
             created_by, created_at,
             case
               when rolled_back_at is not null then 'rolled_back'
               when applied_at is not null     then 'applied'
               else 'pending'
             end as status
        from admin.migrations
       where (${q.project_id ?? null}::uuid is null or project_id = ${q.project_id ?? null})
         and (
           ${actor.isSuperadmin || actor.role === 'service_role'}::boolean
           or project_id in (select project_id from admin.project_members where user_id = ${actor.userId})
         )
       order by coalesce(applied_at, created_at) desc
       limit ${q.limit}`;
    const filtered = q.status ? rows.filter((r: any) => r.status === q.status) : rows;
    return reply.send(filtered);
  });

  app.get<{ Params: { id: string } }>('/admin/v1/migrations/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`select * from admin.migrations where id = ${req.params.id}`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.project_id) await requireProjectRole(cfg, row.project_id, actor, ['owner', 'admin', 'developer', 'viewer']);
    else if (!(actor.isSuperadmin || actor.role === 'service_role')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send(row);
  });

  app.post('/admin/v1/migrations', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = createBody.parse(req.body);
    await assertRole(cfg, body.project_id ?? null, actor);
    const sql = getSql(cfg);
    const version = BigInt(Date.now());
    const checksum = createHash('sha256').update(body.up_sql).digest('hex').slice(0, 32);
    const [row] = await sql<any[]>`
      insert into admin.migrations (project_id, version, name, up_sql, down_sql, checksum, created_by)
      values (${body.project_id ?? null}, ${version}, ${body.name}, ${body.up_sql}, ${body.down_sql}, ${checksum}, ${actor.userId})
      returning id, project_id, version, name, checksum, created_at`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: body.project_id ?? null,
      action: 'migration.create', resource_type: 'migration', resource_id: row.id,
      params: { name: body.name, version: String(row.version) }, result: 'ok',
    });
    return reply.code(201).send(row);
  });

  app.post<{ Params: { id: string } }>('/admin/v1/migrations/:id/apply', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [m] = await sql<any[]>`select * from admin.migrations where id = ${req.params.id}`;
    if (!m) return reply.code(404).send({ error: 'not found' });
    if (m.applied_at && !m.rolled_back_at) return reply.code(409).send({ error: 'already applied' });
    await assertRole(cfg, m.project_id, actor);
    try {
      const t = await timed(async () => {
        await sql.begin(async (tx) => { await tx.unsafe(m.up_sql); });
      });
      const [updated] = await sql<any[]>`
        update admin.migrations
           set applied_at = now(), applied_by = ${actor.userId},
               rolled_back_at = null, rolled_back_by = null
         where id = ${req.params.id}
         returning id, version, name, applied_at`;
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: m.project_id,
        action: 'migration.apply', resource_type: 'migration', resource_id: m.id,
        params: { name: m.name, version: String(m.version) }, result: 'ok', duration_ms: t.ms,
      });
      return reply.send({ ok: true, migration: updated });
    } catch (e: any) {
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: m.project_id,
        action: 'migration.apply', resource_type: 'migration', resource_id: m.id,
        params: { name: m.name }, result: 'error', error_message: e.message,
      });
      return reply.code(400).send({ error: 'apply_failed', message: e.message });
    }
  });

  app.post<{ Params: { id: string } }>('/admin/v1/migrations/:id/rollback', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [m] = await sql<any[]>`select * from admin.migrations where id = ${req.params.id}`;
    if (!m) return reply.code(404).send({ error: 'not found' });
    if (!m.applied_at || m.rolled_back_at) return reply.code(409).send({ error: 'not applied' });
    await assertRole(cfg, m.project_id, actor);

    // Refuse if any newer migration (higher version, same project scope) is currently applied.
    const newer = await sql<any[]>`
      select id, version, name from admin.migrations
       where (project_id is not distinct from ${m.project_id})
         and version > ${m.version}
         and applied_at is not null and rolled_back_at is null
       order by version`;
    if (newer.length) {
      return reply.code(409).send({
        error: 'dependent_migrations_applied',
        message: 'Rollback the following newer migrations first.',
        newer,
      });
    }
    if (!m.down_sql || !m.down_sql.trim()) {
      return reply.code(400).send({ error: 'no_down_sql', message: 'This migration has no down_sql.' });
    }
    try {
      const t = await timed(async () => {
        await sql.begin(async (tx) => { await tx.unsafe(m.down_sql); });
      });
      const [updated] = await sql<any[]>`
        update admin.migrations
           set rolled_back_at = now(), rolled_back_by = ${actor.userId}
         where id = ${req.params.id}
         returning id, version, name, rolled_back_at`;
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: m.project_id,
        action: 'migration.rollback', resource_type: 'migration', resource_id: m.id,
        params: { name: m.name, version: String(m.version) }, result: 'ok', duration_ms: t.ms,
      });
      return reply.send({ ok: true, migration: updated });
    } catch (e: any) {
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: m.project_id,
        action: 'migration.rollback', resource_type: 'migration', resource_id: m.id,
        params: { name: m.name }, result: 'error', error_message: e.message,
      });
      return reply.code(400).send({ error: 'rollback_failed', message: e.message });
    }
  });

  app.delete<{ Params: { id: string } }>('/admin/v1/migrations/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [m] = await sql<any[]>`select * from admin.migrations where id = ${req.params.id}`;
    if (!m) return reply.code(404).send({ error: 'not found' });
    if (m.applied_at && !m.rolled_back_at) {
      return reply.code(409).send({ error: 'cannot delete applied migration' });
    }
    await assertRole(cfg, m.project_id, actor);
    await sql`delete from admin.migrations where id = ${req.params.id}`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: m.project_id,
      action: 'migration.delete', resource_type: 'migration', resource_id: m.id,
      params: {}, result: 'ok',
    });
    return reply.send({ message: 'Deleted' });
  });
}
