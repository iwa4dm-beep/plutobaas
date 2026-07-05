import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const upsertBody = z.object({
  schema: z.string().min(1),
  table:  z.string().min(1),
  perm:   z.enum(['read', 'write', 'admin']),
  principal_kind: z.enum(['user', 'api_key_role']),
  principal_id:   z.string().min(1),
});

export async function grantsRoutes(app: FastifyInstance, cfg: Config) {
  app.get<{ Params: { id: string }; Querystring: { schema?: string; table?: string } }>(
    '/admin/v1/projects/:id/grants',
    async (req, reply) => {
      const actor = await requireAuth(req, cfg);
      await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin', 'developer', 'viewer']);
      const sql = getSql(cfg);
      const rows = await sql`
        select id, schema_name, table_name, perm, principal_kind, principal_id, granted_by, created_at
          from admin.table_grants
         where project_id = ${req.params.id}
           and (${req.query.schema ?? null}::text is null or schema_name = ${req.query.schema ?? null})
           and (${req.query.table  ?? null}::text is null or table_name  = ${req.query.table  ?? null})
         order by schema_name, table_name, perm`;
      return reply.send(rows);
    });

  app.post<{ Params: { id: string } }>('/admin/v1/projects/:id/grants', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin']);
    const body = upsertBody.parse(req.body);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      insert into admin.table_grants
        (project_id, schema_name, table_name, perm, principal_kind, principal_id, granted_by)
      values
        (${req.params.id}, ${body.schema}, ${body.table}, ${body.perm}, ${body.principal_kind}, ${body.principal_id}, ${actor.userId})
      on conflict (project_id, schema_name, table_name, perm, principal_kind, principal_id)
      do update set granted_by = excluded.granted_by
      returning id, schema_name, table_name, perm, principal_kind, principal_id, created_at`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: req.params.id,
      action: 'grants.upsert', resource_type: 'grant', resource_id: row.id,
      params: body as any, result: 'ok',
    });
    return reply.code(201).send(row);
  });

  app.delete<{ Params: { id: string; grantId: string } }>(
    '/admin/v1/projects/:id/grants/:grantId',
    async (req, reply) => {
      const actor = await requireAuth(req, cfg);
      await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin']);
      const sql = getSql(cfg);
      await sql`delete from admin.table_grants
                 where id = ${req.params.grantId} and project_id = ${req.params.id}`;
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: req.params.id,
        action: 'grants.delete', resource_type: 'grant', resource_id: req.params.grantId,
        params: {}, result: 'ok',
      });
      return reply.send({ message: 'Revoked' });
    });
}
