// Edge Functions extensions: cron schedules, per-function secrets, log query.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const secretBody = z.object({
  project_id: z.string().uuid(),
  function_slug: z.string().min(1),
  name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/),
  value: z.string().min(1).max(24576),
});

const cronBody = z.object({
  project_id: z.string().uuid(),
  function_slug: z.string().min(1),
  cron_expr: z.string().min(9).max(120),
  payload: z.record(z.any()).default({}),
  enabled: z.boolean().default(true),
});

const logBody = z.object({
  project_id: z.string().uuid(),
  function_slug: z.string(),
  invocation_id: z.string().uuid().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  message: z.string().min(1).max(8000),
  duration_ms: z.number().int().nonnegative().optional(),
  status: z.number().int().optional(),
  meta: z.record(z.any()).default({}),
});

// Compute next run for a cron expression using a tiny parser
// (fields: min hour dom month dow — supports *, */n, comma lists, and single values).
function nextRun(expr: string, from = new Date()): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((p, i) => {
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]][i] as [number, number];
    const [lo, hi] = ranges;
    if (p === '*') return null;
    const step = p.match(/^\*\/(\d+)$/);
    if (step) {
      const s = Number(step[1]);
      const out: number[] = [];
      for (let v = lo; v <= hi; v += s) out.push(v);
      return out;
    }
    return p.split(',').map((x) => Number(x)).filter((n) => n >= lo && n <= hi);
  });
  const test = new Date(from.getTime() + 60_000);
  test.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    const min = test.getUTCMinutes(), hr = test.getUTCHours();
    const dom = test.getUTCDate(), mon = test.getUTCMonth() + 1, dow = test.getUTCDay();
    const ok =
      (!fields[0] || fields[0].includes(min)) &&
      (!fields[1] || fields[1].includes(hr)) &&
      (!fields[2] || fields[2].includes(dom)) &&
      (!fields[3] || fields[3].includes(mon)) &&
      (!fields[4] || fields[4].includes(dow));
    if (ok) return test;
    test.setUTCMinutes(test.getUTCMinutes() + 1);
  }
  return null;
}

let cronTimer: NodeJS.Timeout | null = null;

async function tickCron(cfg: Config, app: FastifyInstance) {
  const sql = getSql(cfg);
  try {
    const due = await sql<any[]>`
      select * from admin.function_cron
      where enabled = true and (next_run_at is null or next_run_at <= now())
      limit 20`;
    for (const job of due) {
      try {
        // Fire-and-forget internal HTTP invoke; the functions route handles auth via internal token if configured.
        const url = `http://127.0.0.1:${cfg.PORT}/functions/v1/${job.function_slug}?project_id=${job.project_id}`;
        void fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pluto-cron': job.id },
          body: JSON.stringify(job.payload ?? {}),
        }).catch(() => {});
        const next = nextRun(job.cron_expr);
        await sql`update admin.function_cron set last_run_at = now(), next_run_at = ${next as any} where id = ${job.id}`;
      } catch (e) {
        app.log.error({ err: e, job: job.id }, 'cron tick failed');
      }
    }
  } catch (e) {
    app.log.error({ err: e }, 'cron scan failed');
  }
}

export async function functionsPlusRoutes(app: FastifyInstance, cfg: Config) {
  // ---------- Secrets ----------
  app.get('/functions/v1/secrets', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid(), function_slug: z.string() }).parse(req.query);
    return getSql(cfg)`
      select id, name, created_at from admin.function_secrets
      where project_id = ${q.project_id} and function_slug = ${q.function_slug}
      order by name`;
  });

  app.post('/functions/v1/secrets', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = secretBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.function_secrets (project_id, function_slug, name, value)
      values (${body.project_id}, ${body.function_slug}, ${body.name}, ${body.value})
      on conflict (project_id, function_slug, name) do update set value = excluded.value
      returning id, name, created_at`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'function.secret.upsert', target: `${body.function_slug}:${body.name}` });
    reply.code(201).send(row);
  });

  app.delete('/functions/v1/secrets/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.function_secrets where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'function.secret.delete', target: id });
    reply.code(204).send();
  });

  // ---------- Cron ----------
  app.get('/functions/v1/cron', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return getSql(cfg)`select * from admin.function_cron where project_id = ${q.project_id} order by function_slug`;
  });

  app.post('/functions/v1/cron', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = cronBody.parse(req.body);
    const next = nextRun(body.cron_expr);
    if (!next) { reply.code(400).send({ error: 'invalid_cron' }); return; }
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.function_cron (project_id, function_slug, cron_expr, payload, enabled, next_run_at)
      values (${body.project_id}, ${body.function_slug}, ${body.cron_expr}, ${body.payload as any}, ${body.enabled}, ${next as any})
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'function.cron.create', target: body.function_slug, detail: { cron: body.cron_expr } });
    reply.code(201).send(row);
  });

  app.patch('/functions/v1/cron/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const body = z.object({ enabled: z.boolean().optional(), cron_expr: z.string().optional(), payload: z.record(z.any()).optional() }).parse(req.body);
    const sql = getSql(cfg);
    if (body.cron_expr) {
      const next = nextRun(body.cron_expr);
      if (!next) { reply.code(400).send({ error: 'invalid_cron' }); return; }
      await sql`update admin.function_cron set cron_expr = ${body.cron_expr}, next_run_at = ${next as any} where id = ${id}`;
    }
    if (typeof body.enabled === 'boolean') await sql`update admin.function_cron set enabled = ${body.enabled} where id = ${id}`;
    if (body.payload) await sql`update admin.function_cron set payload = ${body.payload as any} where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'function.cron.update', target: id, detail: body });
    const [row] = await sql<any[]>`select * from admin.function_cron where id = ${id}`;
    return row;
  });

  app.delete('/functions/v1/cron/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.function_cron where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'function.cron.delete', target: id });
    reply.code(204).send();
  });

  // ---------- Logs ----------
  app.post('/functions/v1/logs', async (req, reply) => {
    // Ingest — accessible to service_role and function runner too.
    await requireAuth(req, cfg);
    const body = logBody.parse(req.body);
    await getSql(cfg)`
      insert into admin.function_logs
        (project_id, function_slug, invocation_id, level, message, duration_ms, status, meta)
      values (${body.project_id}, ${body.function_slug}, ${body.invocation_id ?? null},
              ${body.level}, ${body.message}, ${body.duration_ms ?? null},
              ${body.status ?? null}, ${body.meta as any})`;
    reply.code(204).send();
  });

  app.get('/functions/v1/logs', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({
      project_id: z.string().uuid(),
      function_slug: z.string().optional(),
      level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }).parse(req.query);
    const sql = getSql(cfg);
    return sql`
      select id, function_slug, invocation_id, level, message, duration_ms, status, meta, logged_at
      from admin.function_logs
      where project_id = ${q.project_id}
        and (${q.function_slug ?? null}::text is null or function_slug = ${q.function_slug ?? null})
        and (${q.level ?? null}::text is null or level = ${q.level ?? null})
      order by logged_at desc limit ${q.limit}`;
  });

  // Start cron scanner (idempotent). Interval: 30s.
  if (!cronTimer) {
    cronTimer = setInterval(() => { void tickCron(cfg, app); }, 30_000);
    app.addHook('onClose', async () => { if (cronTimer) clearInterval(cronTimer); cronTimer = null; });
  }
}
