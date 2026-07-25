/**
 * Support / incident-triage endpoints + admin config for redaction & webhooks.
 *
 *   GET  /admin/v1/traces/:traceId      — single trace (memory → DB fallback)
 *   GET  /admin/v1/traces               — paginated list with filters
 *   GET  /admin/v1/traces/stats         — bucketed error-rate trend (hour|day)
 *
 *   GET/POST/PATCH/DELETE /admin/v1/pii-rules
 *   GET/POST/PATCH/DELETE /admin/v1/alert-webhooks
 *   POST /admin/v1/alert-webhooks/:id/test — send a synthetic alert payload
 *
 * All endpoints require an authenticated service_role token or a superadmin
 * user. Trace payloads are redacted through the admin.pii_redaction_rules
 * table before being returned; the raw audit trail in admin.error_events is
 * preserved so operators can tune rules without losing history.
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
import {
  applyRedaction,
  assertValidPattern,
  invalidateRulesCache,
  loadRules,
  type RedactionRule,
} from '../observability/redaction.js';
import { sendOne, enrichAlertLinks } from '../observability/alert-webhook.js';
import { parseBody, parseParams, parseQuery } from '../util/validate.js';

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
const UuidParam = z.object({ id: z.string().uuid() });

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

const StatsQuery = z.object({
  bucket: z.enum(['hour', 'day']).default('hour'),
  from:   isoDate.optional(),
  to:     isoDate.optional(),
  endpoint: z.string().min(1).max(256).optional(),
  tag:      z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.:\-]+$/).optional(),
});

const RuleBody = z.object({
  name: z.string().min(1).max(128),
  pattern: z.string().min(1).max(500),
  applies_to: z.array(z.enum(['all','message','hint','detail','stack','url','fields','user_agent'])).min(1).default(['all']),
  replacement: z.string().max(64).default('[REDACTED]'),
  enabled: z.boolean().default(true),
  note: z.string().max(500).optional().nullable(),
});
const RulePatch = RuleBody.partial();

const WebhookBody = z.object({
  name: z.string().min(1).max(128),
  url: z.string().url().max(2000),
  secret: z.string().min(8).max(256).optional().nullable(),
  tag_filter: z.array(z.string().min(1).max(64)).default([]),
  enabled: z.boolean().default(true),
});
const WebhookPatch = WebhookBody.partial();

export async function observabilityRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  // --------------------------------------------------------------- traces
  app.get('/admin/v1/traces/:traceId', {
    schema: { description: 'Fetch a captured error event by traceId (redacted).', tags: ['admin'] },
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
        `No captured error event for traceId "${traceId}". It may have been evicted from the buffer AND aged out of the database (30-day retention).`,
      );
      e.statusCode = 404; e.code = 'trace_not_found';
      throw e;
    }
    const rules = await loadRules(cfg);
    reply.header('cache-control', 'no-store');
    return { event: applyRedaction(event, rules), source, redactionRuleCount: rules.length };
  });

  app.get('/admin/v1/traces', {
    schema: { description: 'List captured error events (redacted) with filters + keyset pagination.', tags: ['admin'] },
  }, async (req) => {
    await requireOperator(req, cfg);
    const q = parseQuery(ListQuery, req.query);
    const limit = q.limit ?? 50;
    const { events, nextCursor } = await queryErrorEvents(cfg, {
      limit, cursor: q.cursor, status: q.status, minStatus: q.minStatus, maxStatus: q.maxStatus,
      errorCode: q.errorCode, tag: q.tag, endpoint: q.endpoint, method: q.method,
      actorId: q.actorId, from: q.from, to: q.to,
    });
    const rules = await loadRules(cfg);
    return {
      count: events.length,
      limit,
      nextCursor,
      redactionRuleCount: rules.length,
      events: events.map((e) => applyRedaction(e, rules)),
    };
  });

  // Bucketed error-rate trends. Groups by hour or day + status bucket.
  app.get('/admin/v1/traces/stats', {
    schema: { description: 'Bucketed error-rate trends (5xx, 4xx, validation_failed) for the trend chart.', tags: ['admin'] },
  }, async (req) => {
    await requireOperator(req, cfg);
    const q = parseQuery(StatsQuery, req.query);
    const bucket = q.bucket === 'day' ? 'day' : 'hour';
    const from = q.from ?? new Date(Date.now() - (bucket === 'day' ? 30 : 1) * 86_400_000 * (bucket === 'day' ? 1 : 1)).toISOString();
    const to = q.to ?? new Date().toISOString();
    try {
      const sql = getSql(cfg);
      // Build optional endpoint/tag predicates in a safe, parameterized way.
      const endPat = q.endpoint ? `%${q.endpoint}%` : null;
      const rows = await sql<any[]>`
        SELECT date_trunc(${bucket}, at) AS bucket,
               COUNT(*) FILTER (WHERE status >= 500)                     AS c5xx,
               COUNT(*) FILTER (WHERE status >= 400 AND status < 500)    AS c4xx,
               COUNT(*) FILTER (WHERE code = 'validation_failed')        AS cvalidation,
               COUNT(*)                                                  AS total
          FROM admin.error_events
         WHERE at >= ${from} AND at <= ${to}
           AND (${endPat}::text IS NULL OR endpoint ILIKE ${endPat} OR url ILIKE ${endPat})
           AND (${q.tag ?? null}::text IS NULL OR tag = ${q.tag ?? null})
         GROUP BY 1
         ORDER BY 1 ASC
      `;
      const points = rows.map((r) => ({
        bucket: typeof r.bucket === 'string' ? r.bucket : new Date(r.bucket).toISOString(),
        s5xx: Number(r.c5xx),
        s4xx: Number(r.c4xx),
        validation: Number(r.cvalidation),
        total: Number(r.total),
      }));
      return { bucket, from, to, points };
    } catch (e) {
      // Table missing (migration 0040 not applied) or DB down — return empty
      // series so the UI can render "no data" instead of a hard error.
      return { bucket, from, to, points: [], warning: (e as Error).message };
    }
  });

  // --------------------------------------------------------- PII rules
  app.get('/admin/v1/pii-rules', async (req) => {
    await requireOperator(req, cfg);
    const sql = getSql(cfg);
    const rows = await sql<RedactionRule[]>`
      SELECT id, name, pattern, applies_to, replacement, enabled, note
        FROM admin.pii_redaction_rules
        ORDER BY created_at DESC
    `;
    return { rules: rows };
  });
  app.post('/admin/v1/pii-rules', async (req, reply) => {
    await requireOperator(req, cfg);
    const b = parseBody(RuleBody, req.body);
    assertValidPattern(b.pattern);
    const sql = getSql(cfg);
    const [row] = await sql<RedactionRule[]>`
      INSERT INTO admin.pii_redaction_rules (name, pattern, applies_to, replacement, enabled, note)
      VALUES (${b.name}, ${b.pattern}, ${b.applies_to}, ${b.replacement}, ${b.enabled}, ${b.note ?? null})
      RETURNING id, name, pattern, applies_to, replacement, enabled, note
    `;
    invalidateRulesCache();
    reply.code(201);
    return { rule: row };
  });
  app.patch('/admin/v1/pii-rules/:id', async (req) => {
    await requireOperator(req, cfg);
    const { id } = parseParams(UuidParam, req.params);
    const b = parseBody(RulePatch, req.body);
    if (b.pattern) assertValidPattern(b.pattern);
    const sql = getSql(cfg);
    const [row] = await sql<RedactionRule[]>`
      UPDATE admin.pii_redaction_rules
         SET name        = COALESCE(${b.name ?? null}, name),
             pattern     = COALESCE(${b.pattern ?? null}, pattern),
             applies_to  = COALESCE(${b.applies_to ?? null}, applies_to),
             replacement = COALESCE(${b.replacement ?? null}, replacement),
             enabled     = COALESCE(${b.enabled ?? null}, enabled),
             note        = COALESCE(${b.note ?? null}, note),
             updated_at  = now()
       WHERE id = ${id}
     RETURNING id, name, pattern, applies_to, replacement, enabled, note
    `;
    if (!row) { const e: any = new Error('Rule not found'); e.statusCode = 404; throw e; }
    invalidateRulesCache();
    return { rule: row };
  });
  app.delete('/admin/v1/pii-rules/:id', async (req) => {
    await requireOperator(req, cfg);
    const { id } = parseParams(UuidParam, req.params);
    const sql = getSql(cfg);
    await sql`DELETE FROM admin.pii_redaction_rules WHERE id = ${id}`;
    invalidateRulesCache();
    return { ok: true };
  });

  // --------------------------------------------------------- alert webhooks
  app.get('/admin/v1/alert-webhooks', async (req) => {
    await requireOperator(req, cfg);
    const sql = getSql(cfg);
    const rows = await sql<any[]>`
      SELECT id, name, url, tag_filter, enabled, failure_count,
             last_delivery_at, last_error, last_status, created_at,
             (secret IS NOT NULL) AS has_secret
        FROM admin.alert_webhooks
        ORDER BY created_at DESC
    `;
    return { webhooks: rows };
  });
  app.post('/admin/v1/alert-webhooks', async (req, reply) => {
    await requireOperator(req, cfg);
    const b = parseBody(WebhookBody, req.body);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      INSERT INTO admin.alert_webhooks (name, url, secret, tag_filter, enabled)
      VALUES (${b.name}, ${b.url}, ${b.secret ?? null}, ${b.tag_filter}, ${b.enabled})
      RETURNING id, name, url, tag_filter, enabled, failure_count,
                last_delivery_at, last_error, last_status, created_at,
                (secret IS NOT NULL) AS has_secret
    `;
    reply.code(201);
    return { webhook: row };
  });
  app.patch('/admin/v1/alert-webhooks/:id', async (req) => {
    await requireOperator(req, cfg);
    const { id } = parseParams(UuidParam, req.params);
    const b = parseBody(WebhookPatch, req.body);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      UPDATE admin.alert_webhooks
         SET name       = COALESCE(${b.name ?? null}, name),
             url        = COALESCE(${b.url ?? null}, url),
             secret     = COALESCE(${b.secret ?? null}, secret),
             tag_filter = COALESCE(${b.tag_filter ?? null}, tag_filter),
             enabled    = COALESCE(${b.enabled ?? null}, enabled)
       WHERE id = ${id}
     RETURNING id, name, url, tag_filter, enabled, failure_count,
               last_delivery_at, last_error, last_status, created_at,
               (secret IS NOT NULL) AS has_secret
    `;
    if (!row) { const e: any = new Error('Webhook not found'); e.statusCode = 404; throw e; }
    return { webhook: row };
  });
  app.delete('/admin/v1/alert-webhooks/:id', async (req) => {
    await requireOperator(req, cfg);
    const { id } = parseParams(UuidParam, req.params);
    const sql = getSql(cfg);
    await sql`DELETE FROM admin.alert_webhooks WHERE id = ${id}`;
    return { ok: true };
  });
  app.post('/admin/v1/alert-webhooks/:id/test', async (req) => {
    await requireOperator(req, cfg);
    const { id } = parseParams(UuidParam, req.params);
    const sql = getSql(cfg);
    const [hook] = await sql<any[]>`SELECT id, name, url, secret, tag_filter, enabled FROM admin.alert_webhooks WHERE id = ${id}`;
    if (!hook) { const e: any = new Error('Webhook not found'); e.statusCode = 404; throw e; }
    const synthetic = enrichAlertLinks({
      tag: 'test',
      count: 0,
      windowMs: 300000,
      threshold: 10,
      sampleTraceIds: ['test-trace-id'],
      lookupUrlTemplate: '/admin/v1/traces/{traceId}',
      listUrl: '/admin/v1/traces',
    });
    const result = await sendOne(cfg, hook, {
      type: 'pluto.alert.test',
      alert: true,
      at: new Date().toISOString(),
      ...synthetic,
    });
    return result;
  });
}
