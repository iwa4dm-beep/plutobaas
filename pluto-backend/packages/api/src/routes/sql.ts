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
  // Explicit allowlist for DDL that changes the schema (DROP, ALTER, TRUNCATE,
  // REVOKE, RENAME, …). Without this flag any such statement is rejected
  // BEFORE reaching Postgres, even for superadmins in write mode.
  allow_dangerous: z.boolean().optional().default(false),
});

// Verbs that permanently mutate or destroy schema/data. `write` verbs
// (insert/update/delete) are gated separately by confirm_destructive.
const DANGEROUS_SCHEMA_VERBS = new Set([
  'drop', 'alter', 'truncate', 'revoke', 'rename',
]);

export async function sqlRoutes(app: FastifyInstance, cfg: Config) {
  // Lightweight health probe — deploy verification hits GET to confirm the
  // SQL surface is mounted after `docker compose restart api`.
  app.get('/admin/v1/sql/run', async (_req, reply) =>
    reply.code(200).send({ ok: true, route: '/admin/v1/sql/run', method: 'POST' })
  );

  const execHandler = async (req: any, reply: any) => {
    const actor = await requireAuth(req, cfg);

    // Superadmin-only surface. Both /sql/run and /sql/exec require the caller
    // to be a superadmin (or the internal service_role). This is checked BEFORE
    // parsing the body so probe/enumeration attempts get a clear 403.
    if (!(actor.isSuperadmin || actor.role === 'service_role')) {
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: null,
        action: 'sql.exec', resource_type: 'sql',
        params: { reason: 'not_superadmin', role: actor.role },
        result: 'blocked', error_message: 'forbidden_superadmin_required',
      });
      return reply.code(403).send({
        error: 'forbidden',
        message: 'superadmin role required to execute SQL via /admin/v1/sql/run',
      });
    }

    const body = execBody.parse(req.body);
    if (body.project_id) {
      await requireProjectRole(cfg, body.project_id, actor, ['owner', 'admin', 'developer']);
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

    // Dangerous-DDL gate — DROP/ALTER/TRUNCATE/REVOKE/RENAME require an explicit
    // allow_dangerous:true flag from the caller, on top of confirm_destructive.
    const dangerous = classifications.find((c) => DANGEROUS_SCHEMA_VERBS.has((c.verb || '').toLowerCase()));
    if (dangerous && !body.allow_dangerous) {
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: body.project_id ?? null,
        action: 'sql.exec', resource_type: 'sql',
        params: { classifications, mode: body.read_only ? 'read_only' : 'write' },
        result: 'blocked', error_message: 'dangerous_ddl_blocked',
      });
      return reply.code(409).send({
        error: 'dangerous_ddl_blocked',
        message: `Statement "${dangerous.verb.toUpperCase()}" is blocked. Retry with allow_dangerous:true and confirm_destructive:true.`,
        classifications,
        dangerous_verbs: [...DANGEROUS_SCHEMA_VERBS],
      });
    }

    // Destructive gate (write verbs + dangerous DDL still need explicit confirm).
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
          return await sql.begin(async (tx) => {
            await tx.unsafe('set transaction read only');
            const rows = await tx.unsafe(body.sql, body.params);
            return rows;
          });
        }
        return await sql.unsafe(body.sql, body.params);
      });
      const rows = t.result as unknown as any[];
      await logAudit(cfg, {
        actor_id: actor.userId, project_id: body.project_id ?? null,
        action: 'sql.exec', resource_type: 'sql',
        params: {
          classifications, read_only: body.read_only,
          allow_dangerous: body.allow_dangerous,
          rowCount: Array.isArray(rows) ? rows.length : 0,
        },
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
  };

  app.post('/admin/v1/sql/exec', execHandler);
  // Stable alias used by external tooling / dashboard.
  app.post('/admin/v1/sql/run', execHandler);




  // Preview classification without executing.
  app.post('/admin/v1/sql/classify', async (req, reply) => {
    await requireAuth(req, cfg);
    const body = z.object({ sql: z.string().min(1).max(200_000) }).parse(req.body);
    const classifications = splitStatements(body.sql).map(classifySql);
    return reply.send({ classifications });
  });
}
