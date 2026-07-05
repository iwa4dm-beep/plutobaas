import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';

const listQ = z.object({
  project_id: z.string().uuid().optional(),
  action: z.string().optional(),
  actor_id: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export async function auditRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/admin/v1/audit', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const q = listQ.parse(req.query);
    const sql = getSql(cfg);

    // Scope: superadmin sees all; others see rows for projects they belong to,
    // plus their own actions.
    const rows = actor.isSuperadmin || actor.role === 'service_role'
      ? await sql`
          select id, actor_id, project_id, action, resource_type, resource_id,
                 params, result, duration_ms, error_message, created_at
            from admin.audit_log
           where (${q.project_id ?? null}::uuid is null or project_id = ${q.project_id ?? null})
             and (${q.action     ?? null}::text is null or action     = ${q.action     ?? null})
             and (${q.actor_id   ?? null}::uuid is null or actor_id   = ${q.actor_id   ?? null})
             and (${q.since      ?? null}::timestamptz is null or created_at >= ${q.since ?? null})
           order by created_at desc
           limit ${q.limit} offset ${q.offset}`
      : await sql`
          select id, actor_id, project_id, action, resource_type, resource_id,
                 params, result, duration_ms, error_message, created_at
            from admin.audit_log
           where (
             actor_id = ${actor.userId}
             or project_id in (select project_id from admin.project_members where user_id = ${actor.userId})
           )
             and (${q.project_id ?? null}::uuid is null or project_id = ${q.project_id ?? null})
             and (${q.action     ?? null}::text is null or action     = ${q.action     ?? null})
             and (${q.since      ?? null}::timestamptz is null or created_at >= ${q.since ?? null})
           order by created_at desc
           limit ${q.limit} offset ${q.offset}`;

    return reply.send(rows);
  });

  app.get<{ Params: { id: string } }>('/admin/v1/audit/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`select * from admin.audit_log where id = ${req.params.id}`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!(actor.isSuperadmin || actor.role === 'service_role')
        && row.actor_id !== actor.userId) {
      if (row.project_id) {
        const [m] = await sql<any[]>`select 1 from admin.project_members
          where project_id = ${row.project_id} and user_id = ${actor.userId}`;
        if (!m) return reply.code(403).send({ error: 'forbidden' });
      } else {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    return reply.send(row);
  });
}
