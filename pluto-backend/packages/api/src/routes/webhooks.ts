import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const EVENT_TYPES = [
  'row.inserted', 'row.updated', 'row.deleted',
  'auth.user.created', 'auth.user.deleted',
  'storage.object.created', 'storage.object.deleted',
  'function.invoked', 'function.failed',
] as const;

const subBody = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  target_url: z.string().url(),
  events: z.array(z.enum(EVENT_TYPES)).min(1),
  filter_schema: z.string().optional(),
  filter_table: z.string().optional(),
  max_retries: z.number().int().min(0).max(20).default(5),
  timeout_ms: z.number().int().min(500).max(60000).default(10000),
  enabled: z.boolean().default(true),
});

function sign(secret: string, body: string, ts: number) {
  const base = `${ts}.${body}`;
  return `t=${ts},v1=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

async function deliverOnce(sub: any, ev: any, cfg: Config): Promise<{ok: boolean; status?: number; body?: string; dur: number}> {
  const start = Date.now();
  const body = JSON.stringify({ id: ev.id, event: ev.event_type, payload: ev.payload, delivered_at: new Date().toISOString() });
  const ts = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), sub.timeout_ms);
  try {
    const res = await fetch(sub.target_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pluto-event': ev.event_type,
        'x-pluto-signature': sign(sub.secret, body, ts),
        'x-pluto-delivery': ev.id,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: text.slice(0, 2000), dur: Date.now() - start };
  } catch (e: any) {
    return { ok: false, body: String(e.message ?? e), dur: Date.now() - start };
  } finally {
    clearTimeout(t);
  }
}

// Enqueue an event for all matching subscriptions in a project. Used by other routes.
export async function emitWebhookEvent(
  cfg: Config,
  args: { project_id: string; event_type: string; payload: any; schema?: string; table?: string },
) {
  const sql = getSql(cfg);
  const subs = await sql`
    select * from admin.webhook_subscriptions
     where project_id = ${args.project_id}
       and enabled = true
       and ${args.event_type} = any(events)
       and (filter_schema is null or filter_schema = ${args.schema ?? null})
       and (filter_table  is null or filter_table  = ${args.table  ?? null})`;
  for (const s of subs) {
    const [d] = await sql`
      insert into admin.webhook_deliveries (subscription_id, event_type, payload, status, next_retry_at)
      values (${s.id}, ${args.event_type}, ${sql.json(args.payload)}, 'pending', now())
      returning *`;
    // best-effort immediate attempt
    processDelivery(cfg, s, d).catch(() => {});
  }
}

async function processDelivery(cfg: Config, sub: any, deliv: any) {
  const sql = getSql(cfg);
  const attempt = deliv.attempt + 1;
  const res = await deliverOnce(sub, deliv, cfg);
  if (res.ok) {
    await sql`
      update admin.webhook_deliveries
         set status='delivered', attempt=${attempt}, response_status=${res.status ?? null},
             response_body=${res.body ?? null}, duration_ms=${res.dur}, updated_at=now()
       where id = ${deliv.id}`;
    return;
  }
  const dead = attempt >= sub.max_retries;
  const backoff = Math.min(60 * 60, 5 * Math.pow(2, attempt)); // sec
  await sql`
    update admin.webhook_deliveries
       set status=${dead ? 'dead' : 'failed'}, attempt=${attempt},
           response_status=${res.status ?? null}, response_body=${res.body ?? null},
           duration_ms=${res.dur},
           next_retry_at=${dead ? null : new Date(Date.now() + backoff * 1000).toISOString()},
           updated_at=now()
     where id = ${deliv.id}`;
}

export async function webhooksRoutes(app: FastifyInstance, cfg: Config) {
  // Subscriptions CRUD
  app.get('/admin/v1/webhooks', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(actor, q.project_id, ['owner', 'admin', 'member'], cfg);
    return getSql(cfg)`
      select id, name, target_url, events, filter_schema, filter_table,
             enabled, max_retries, timeout_ms, created_at
        from admin.webhook_subscriptions
       where project_id = ${q.project_id}
       order by created_at desc`;
  });

  app.post('/admin/v1/webhooks', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = subBody.parse(req.body);
    await requireProjectRole(actor, body.project_id, ['owner', 'admin'], cfg);
    const sql = getSql(cfg);
    const secret = randomBytes(24).toString('base64url');
    const [row] = await sql`
      insert into admin.webhook_subscriptions
        (project_id, name, target_url, events, filter_schema, filter_table,
         secret, enabled, max_retries, timeout_ms)
      values (${body.project_id}, ${body.name}, ${body.target_url}, ${body.events},
              ${body.filter_schema ?? null}, ${body.filter_table ?? null},
              ${secret}, ${body.enabled}, ${body.max_retries}, ${body.timeout_ms})
      returning *`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: body.project_id,
      action: 'webhook.create', resource_type: 'webhook', resource_id: row.id, params: { name: body.name },
    });
    // Return secret ONCE (client stores it, or uses it to verify signatures)
    return { ...row, secret_shown_once: true };
  });

  app.patch('/admin/v1/webhooks/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = subBody.partial().parse(req.body);
    const sql = getSql(cfg);
    const [existing] = await sql`select project_id from admin.webhook_subscriptions where id=${id}`;
    if (!existing) return { error: 'not_found' };
    await requireProjectRole(actor, existing.project_id, ['owner', 'admin'], cfg);
    const [row] = await sql`
      update admin.webhook_subscriptions set
        name         = coalesce(${patch.name ?? null}, name),
        target_url   = coalesce(${patch.target_url ?? null}, target_url),
        events       = coalesce(${patch.events ?? null}, events),
        filter_schema= ${patch.filter_schema ?? null},
        filter_table = ${patch.filter_table ?? null},
        enabled      = coalesce(${patch.enabled ?? null}, enabled),
        max_retries  = coalesce(${patch.max_retries ?? null}, max_retries),
        timeout_ms   = coalesce(${patch.timeout_ms ?? null}, timeout_ms)
      where id = ${id} returning *`;
    return row;
  });

  app.delete('/admin/v1/webhooks/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [row] = await sql`select project_id from admin.webhook_subscriptions where id=${id}`;
    if (!row) return { ok: true };
    await requireProjectRole(actor, row.project_id, ['owner', 'admin'], cfg);
    await sql`delete from admin.webhook_subscriptions where id=${id}`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: row.project_id,
      action: 'webhook.delete', resource_type: 'webhook', resource_id: id,
    });
    return { ok: true };
  });

  // Rotate secret
  app.post('/admin/v1/webhooks/:id/rotate', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [row] = await sql`select project_id from admin.webhook_subscriptions where id=${id}`;
    if (!row) return { error: 'not_found' };
    await requireProjectRole(actor, row.project_id, ['owner', 'admin'], cfg);
    const secret = randomBytes(24).toString('base64url');
    await sql`update admin.webhook_subscriptions set secret=${secret} where id=${id}`;
    return { secret, shown_once: true };
  });

  // Send test event
  app.post('/admin/v1/webhooks/:id/test', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [sub] = await sql`select * from admin.webhook_subscriptions where id=${id}`;
    if (!sub) return { error: 'not_found' };
    await requireProjectRole(actor, sub.project_id, ['owner', 'admin'], cfg);
    const [d] = await sql`
      insert into admin.webhook_deliveries (subscription_id, event_type, payload, status, next_retry_at)
      values (${sub.id}, 'test.ping', ${sql.json({ hello: 'world', ts: Date.now() })}, 'pending', now())
      returning *`;
    await processDelivery(cfg, sub, d);
    const [after] = await sql`select * from admin.webhook_deliveries where id=${d.id}`;
    return after;
  });

  // Deliveries list
  app.get('/admin/v1/webhooks/:id/deliveries', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [sub] = await sql`select project_id from admin.webhook_subscriptions where id=${id}`;
    if (!sub) return [];
    await requireProjectRole(actor, sub.project_id, ['owner', 'admin', 'member'], cfg);
    return sql`
      select id, event_type, attempt, status, response_status, duration_ms, next_retry_at, created_at, updated_at
        from admin.webhook_deliveries
       where subscription_id = ${id}
       order by created_at desc
       limit 200`;
  });

  // Retry a failed delivery
  app.post('/admin/v1/deliveries/:id/retry', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [deliv] = await sql`select * from admin.webhook_deliveries where id=${id}`;
    if (!deliv) return { error: 'not_found' };
    const [sub] = await sql`select * from admin.webhook_subscriptions where id=${deliv.subscription_id}`;
    await requireProjectRole(actor, sub.project_id, ['owner', 'admin'], cfg);
    await processDelivery(cfg, sub, deliv);
    const [after] = await sql`select * from admin.webhook_deliveries where id=${id}`;
    return after;
  });

  // Signature verification helper — clients hit this to validate their code path
  app.post('/admin/v1/webhooks/verify', async (req, reply) => {
    const b = z.object({
      secret: z.string(),
      timestamp: z.number().int(),
      body: z.string(),
      signature: z.string(),
    }).parse(req.body);
    const expected = sign(b.secret, b.body, b.timestamp);
    const ok = expected.length === b.signature.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(b.signature));
    if (!ok) reply.code(400);
    return { ok };
  });
}
