import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const quotaBody = z.object({
  project_id: z.string().uuid(),
  metric: z.string().min(1).max(80),
  soft_limit: z.number().int().nullable().optional(),
  hard_limit: z.number().int().nullable().optional(),
  window: z.enum(['day', 'month']).default('month'),
  enabled: z.boolean().default(true),
});

const alertBody = z.object({
  project_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  metric: z.string().min(1).max(120),
  operator: z.enum(['>', '>=', '<', '<=', '=']),
  threshold: z.number(),
  window_seconds: z.number().int().min(30).max(24 * 3600).default(300),
  channel: z.enum(['email', 'webhook']).default('email'),
  target: z.string().min(3).max(500),
  enabled: z.boolean().default(true),
});

// Public: middleware in other routes can call this to bump usage.
export async function bumpUsage(cfg: Config, projectId: string, metric: string, delta = 1) {
  const sql = getSql(cfg);
  await sql`select admin.bump_usage(${projectId}, ${metric}, ${delta})`;
}

export async function billingRoutes(app: FastifyInstance, cfg: Config) {
  // Usage summary
  app.get('/admin/v1/usage', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({
      project_id: z.string().uuid(),
      period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(),
    }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    const sql = getSql(cfg);
    const period = q.period ?? new Date().toISOString().slice(0, 7);
    const usage = await sql`
      select metric, period, value, updated_at
        from admin.usage_counters
       where project_id = ${q.project_id}
         and period like ${period + '%'}
       order by metric`;
    const quotas = await sql`
      select metric, soft_limit, hard_limit, window, enabled
        from admin.quotas
       where project_id = ${q.project_id}`;
    return { period, usage, quotas };
  });

  // Quotas
  app.get('/admin/v1/quotas', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    return getSql(cfg)`
      select * from admin.quotas where project_id = ${q.project_id} order by metric`;
  });

  app.post('/admin/v1/quotas', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = quotaBody.parse(req.body);
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);
    const [row] = await sql`
      insert into admin.quotas (project_id, metric, soft_limit, hard_limit, window, enabled)
      values (${b.project_id}, ${b.metric}, ${b.soft_limit ?? null}, ${b.hard_limit ?? null}, ${b.window}, ${b.enabled})
      on conflict (project_id, metric, window)
      do update set soft_limit = excluded.soft_limit,
                    hard_limit = excluded.hard_limit,
                    enabled    = excluded.enabled
      returning *`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: b.project_id,
      action: 'quota.upsert', resource_type: 'quota', resource_id: row.id, params: b,
    });
    return row;
  });

  app.delete('/admin/v1/quotas/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [row] = await sql`select project_id from admin.quotas where id=${id}`;
    if (!row) return { ok: true };
    await requireProjectRole(cfg, row.project_id, actor, ['owner', 'admin']);
    await sql`delete from admin.quotas where id=${id}`;
    return { ok: true };
  });

  // Alert rules
  app.get('/admin/v1/alerts', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid().optional() }).parse(req.query);
    const sql = getSql(cfg);
    if (q.project_id) {
      await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
      return sql`select * from admin.alert_rules where project_id = ${q.project_id} order by created_at desc`;
    }
    if (!actor.isSuperadmin) return [];
    return sql`select * from admin.alert_rules order by created_at desc`;
  });

  app.post('/admin/v1/alerts', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = alertBody.parse(req.body);
    if (b.project_id) {
      await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin']);
    } else if (!actor.isSuperadmin) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }
    const sql = getSql(cfg);
    const [row] = await sql`
      insert into admin.alert_rules
        (project_id, name, metric, operator, threshold, window_seconds, channel, target, enabled)
      values (${b.project_id ?? null}, ${b.name}, ${b.metric}, ${b.operator}, ${b.threshold},
              ${b.window_seconds}, ${b.channel}, ${b.target}, ${b.enabled})
      returning *`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: b.project_id ?? null,
      action: 'alert.create', resource_type: 'alert', resource_id: row.id, params: b,
    });
    return row;
  });

  app.patch('/admin/v1/alerts/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = alertBody.partial().parse(req.body);
    const sql = getSql(cfg);
    const [existing] = await sql`select project_id from admin.alert_rules where id=${id}`;
    if (!existing) return { error: 'not_found' };
    if (existing.project_id) await requireProjectRole(cfg, existing.project_id, actor, ['owner', 'admin']);
    else if (!actor.isSuperadmin) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    const [row] = await sql`
      update admin.alert_rules set
        name           = coalesce(${patch.name ?? null}, name),
        metric         = coalesce(${patch.metric ?? null}, metric),
        operator       = coalesce(${patch.operator ?? null}, operator),
        threshold      = coalesce(${patch.threshold ?? null}, threshold),
        window_seconds = coalesce(${patch.window_seconds ?? null}, window_seconds),
        channel        = coalesce(${patch.channel ?? null}, channel),
        target         = coalesce(${patch.target ?? null}, target),
        enabled        = coalesce(${patch.enabled ?? null}, enabled)
      where id = ${id} returning *`;
    return row;
  });

  app.delete('/admin/v1/alerts/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [row] = await sql`select project_id from admin.alert_rules where id=${id}`;
    if (!row) return { ok: true };
    if (row.project_id) await requireProjectRole(cfg, row.project_id, actor, ['owner', 'admin']);
    else if (!actor.isSuperadmin) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    await sql`delete from admin.alert_rules where id=${id}`;
    return { ok: true };
  });
}
