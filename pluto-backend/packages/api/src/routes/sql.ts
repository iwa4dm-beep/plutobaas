import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { classifySql, splitStatements } from '../sql/classifier.js';
import { logAudit, timed } from '../audit/logger.js';

const execBody = z.object({
  project_id: z.string().uuid().optional(),
  sql: z.string().min(1).max(200_000),
  params: z.array(z.any()).optional().default([]),
  read_only: z.boolean().optional().default(true),
  confirm_destructive: z.boolean().optional().default(false),
});

export async function sqlRoutes(app: FastifyInstance, cfg: Config) {
  app.post('/admin/v1/sql/exec', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = execBody.parse(req.body);
    if (body.project_id) await requireProjectRole(cfg, body.project_id, actor, ['owner', 'admin', 'developer']);
    else if (!(actor.isSuperadmin || actor.role === 'service_role')) {
      return reply.code(403).send({ error: 'forbidden', message: 'project_id required for non-superadmin' });
    }

    const stmts = splitStatements(body.sql);
    const classifications = stmts.map(classifySql);

    // Read-only gate.
    if (body.read_only) {
      const bad = classifications.find((c) => c.class !== 'safe');
      if (bad) {
        await logAudit(cfg, {
          actor_id: actor.userId, project_id: body.project_id ?? null,
          action: 'sql.exec', resource_type: 'sql',
          params: { classifications, mode: 'read_only' },
          result: 'blocked', error_message: 'read_only_violation',
        });
        return reply.code(409).send({
          error: 'read_only_violation',
          message: `Statement "${bad.verb}" is not allowed in read-only mode.`,
          classifications,
        });
      }
    }

    // Destructive gate.
    const destructive = classifications.find((c) => c.destructive);
    if (destructive && !body.confirm_destructive) {
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: body.project_id ?? null,
        action: 'sql.exec', resource_type: 'sql',
        params: { classifications, mode: body.read_only ? 'read_only' : 'write' },
        result: 'blocked', error_message: 'destructive_requires_confirmation',
      });
      return reply.code(409).send({
        error: 'destructive_requires_confirmation',
        message: `Destructive verb "${destructive.verb}" requires confirm_destructive:true.`,
        classifications,
      });
    }

    const sql = getSql(cfg);
    try {
      const t = await timed(async () => {
        if (body.read_only) {
          // READ ONLY transaction — DB is authoritative regardless of classifier.
          return await sql.begin(async (tx) => {
            await tx.unsafe('set transaction read only');
            const rows = await tx.unsafe(body.sql, body.params);
            return rows;
          });
        }
        // Destructive already confirmed above.
        return await sql.unsafe(body.sql, body.params);
      });
      const rows = t.result as unknown as any[];
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: body.project_id ?? null,
        action: 'sql.exec', resource_type: 'sql',
        params: { classifications, read_only: body.read_only, rowCount: Array.isArray(rows) ? rows.length : 0 },
        result: 'ok', duration_ms: t.ms,
      });
      return reply.send({
        ok: true,
        classifications,
        row_count: Array.isArray(rows) ? rows.length : 0,
        rows: Array.isArray(rows) ? rows.slice(0, 1000) : rows,
        duration_ms: t.ms,
      });
    } catch (e: any) {
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: body.project_id ?? null,
        action: 'sql.exec', resource_type: 'sql',
        params: { classifications }, result: 'error', error_message: e.message,
      });
      return reply.code(400).send({ error: 'sql_error', message: e.message, classifications });
    }
  });

  // Preview classification without executing.
  app.post('/admin/v1/sql/classify', async (req, reply) => {
    await requireAuth(req, cfg);
    const body = z.object({ sql: z.string().min(1).max(200_000) }).parse(req.body);
    const classifications = splitStatements(body.sql).map(classifySql);
    return reply.send({ classifications });
  });
}
