/**
 * Support / incident-triage endpoints.
 *
 *   GET /admin/v1/traces/:traceId  — fetch a single captured error event
 *                                    (in-memory first, DB fallback).
 *   GET /admin/v1/traces           — list with pagination + filters.
 *
 * Filters on the list endpoint:
 *   status       exact status code (e.g. 500)
 *   minStatus    lower bound (e.g. 400)
 *   maxStatus    upper bound (e.g. 599)
 *   errorCode    exact error `code` (e.g. validation_failed, 23505)
 *   tag          exact error `tag` (e.g. validation, internal, client)
 *   endpoint     substring match on endpoint OR url
 *   method       HTTP method (GET, POST, ...)
 *   actorId      user UUID
 *   from,to      ISO timestamps (inclusive)
 *   limit        1..200 (default 50)
 *   cursor       ISO timestamp — returns rows strictly older than cursor
 *
 * Pagination is keyset by `at` (descending). The response includes
 * `nextCursor` (null when exhausted); the client passes it as `cursor` on
 * the next page.
 *
 * Both endpoints require an authenticated service_role token or a
 * superadmin user. Trace payloads can contain hint/detail/stack fragments
 * that are safe for operators but not for end-users.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';
import {
  lookupErrorEvent,
  lookupErrorEventDb,
  queryErrorEvents,
} from '../observability/error-log.js';
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

// Coerce string query params to numbers where useful, with safe bounds.
const intFromString = (min: number, max: number) =>
  z.string().transform((v, ctx) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < min || n > max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer in [${min}, ${max}]` });
      return z.NEVER;
    }
    return n;
  });

const isoDate = z.string().refine(
  (v) => !Number.isNaN(Date.parse(v)),
  { message: 'must be an ISO-8601 timestamp' },
);

const ListQuery = z.object({
  limit:      intFromString(1, 200).optional(),
  cursor:     isoDate.optional(),
  status:     intFromString(100, 599).optional(),
  minStatus:  intFromString(100, 599).optional(),
  maxStatus:  intFromString(100, 599).optional(),
  errorCode:  z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.:\-]+$/).optional(),
  tag:        z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.:\-]+$/).optional(),
  endpoint:   z.string().min(1).max(256).optional(),
  method:     z.enum(['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD']).optional(),
  actorId:    z.string().uuid().optional(),
  from:       isoDate.optional(),
  to:         isoDate.optional(),
});

export async function observabilityRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  app.get('/admin/v1/traces/:traceId', {
    schema: {
      description:
        'Fetch a captured error event by traceId. Requires service_role or superadmin. ' +
        'Checks the in-memory ring buffer first, then falls back to the durable ' +
        '`admin.error_events` table (30-day retention).',
      tags: ['admin'],
    },
  }, async (req, reply) => {
    await requireOperator(req, cfg);
    const { traceId } = parseParams(TraceIdParam, req.params);
    let event = lookupErrorEvent(traceId);
    let source: 'memory' | 'database' = 'memory';
    if (!event) {
      event = await lookupErrorEventDb(cfg, traceId);
      source = 'database';
    }
    if (!event) {
      const e: any = new Error(
        `No captured error event for traceId "${traceId}". ` +
        `It may have been evicted from the buffer AND aged out of the database ` +
        `(30-day retention). Check server logs for older events.`,
      );
      e.statusCode = 404;
      e.code = 'trace_not_found';
      throw e;
    }
    reply.header('cache-control', 'no-store');
    return { event, source };
  });

  app.get('/admin/v1/traces', {
    schema: {
      description:
        'List captured error events (newest first) with filtering + keyset pagination. ' +
        'Filters: status, minStatus, maxStatus, errorCode, tag, endpoint (substring), method, ' +
        'actorId, from, to. Pass `cursor` from the previous response to fetch the next page. ' +
        'Requires service_role or superadmin.',
      tags: ['admin'],
    },
  }, async (req) => {
    await requireOperator(req, cfg);
    const q = parseQuery(ListQuery, req.query);
    const limit = q.limit ?? 50;
    const { events, nextCursor } = await queryErrorEvents(cfg, {
      limit,
      cursor:    q.cursor,
      status:    q.status,
      minStatus: q.minStatus,
      maxStatus: q.maxStatus,
      errorCode: q.errorCode,
      tag:       q.tag,
      endpoint:  q.endpoint,
      method:    q.method,
      actorId:   q.actorId,
      from:      q.from,
      to:        q.to,
    });
    return {
      count: events.length,
      limit,
      nextCursor,
      events,
    };
  });
}
