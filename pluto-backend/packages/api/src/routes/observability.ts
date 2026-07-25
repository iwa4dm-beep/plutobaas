/**
 * Support / incident-triage endpoints.
 *
 *   GET /admin/v1/traces/:traceId  — fetch a single captured error event
 *   GET /admin/v1/traces           — list the most recent N (default 50, max 200)
 *
 * Both require an authenticated service_role token or a superadmin user.
 * Regular authenticated users receive 403 — trace data can contain
 * hint/detail/stack fragments that are safe for operators but not for
 * end-users.
 *
 * All responses share the standard error envelope on failure; the success
 * shape is `{ event }` or `{ events: [...] }`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';
import { lookupErrorEvent, listRecentErrors } from '../observability/error-log.js';
import { parseParams, parseQuery } from '../util/validate.js';

type Actor = { userId: string; role: 'authenticated' | 'service_role'; isSuperadmin: boolean };

async function requireOperator(req: FastifyRequest, cfg: Config): Promise<Actor> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    const e: any = new Error('Unauthorized'); e.statusCode = 401; throw e;
  }
  const decoded: any = await (req as any).jwtVerify();
  const userId = decoded?.sub;
  if (!userId) { const e: any = new Error('Invalid token'); e.statusCode = 401; throw e; }
  const role = decoded?.role === 'service_role' ? 'service_role' : 'authenticated';
  let isSuperadmin = false;
  try {
    const sql = getSql(cfg);
    const [u] = await sql<any[]>`select is_superadmin from auth.users where id = ${userId}`;
    isSuperadmin = !!u?.is_superadmin;
  } catch { /* DB down → non-superadmin, service_role still passes */ }
  if (role !== 'service_role' && !isSuperadmin) {
    const e: any = new Error('Only operators can read trace events.'); e.statusCode = 403; throw e;
  }
  return { userId, role, isSuperadmin };
}

const TraceIdParam = z.object({
  traceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-.:]+$/, 'invalid trace id format'),
});

const ListQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 50))
    .pipe(z.number().int().min(1).max(200)),
});

export async function observabilityRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  app.get('/admin/v1/traces/:traceId', {
    schema: {
      description: 'Fetch a captured error event by traceId. Requires service_role or superadmin. Buffer is in-memory (~2000 most recent events); for older events consult server logs via `docker logs api | grep <traceId>`.',
      tags: ['admin'],
    },
  }, async (req, reply) => {
    await requireOperator(req, cfg);
    const { traceId } = parseParams(TraceIdParam, req.params);
    const event = lookupErrorEvent(traceId);
    if (!event) {
      // Standard 404 envelope so clients get consistent shape.
      const e: any = new Error(`No captured error event for traceId "${traceId}". It may have been evicted from the in-memory buffer or the request succeeded — check server logs.`);
      e.statusCode = 404;
      e.code = 'trace_not_found';
      throw e;
    }
    reply.header('cache-control', 'no-store');
    return { event };
  });

  app.get('/admin/v1/traces', {
    schema: {
      description: 'List the most recent captured error events (newest first). Requires service_role or superadmin.',
      tags: ['admin'],
    },
  }, async (req) => {
    await requireOperator(req, cfg);
    const { limit } = parseQuery(ListQuery, req.query);
    const events = listRecentErrors(limit);
    return { count: events.length, events };
  });
}
