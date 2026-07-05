// Durable job queue: enqueue, claim (SKIP LOCKED), ack/nack with backoff, DLQ.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const queueBody = z.object({
  project_id: z.string().uuid(),
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,60}$/),
  max_concurrency: z.number().int().min(1).max(500).default(5),
  visibility_sec: z.number().int().min(5).max(3600).default(30),
  max_attempts: z.number().int().min(1).max(20).default(5),
});

const enqueueBody = z.object({
  queue_id: z.string().uuid(),
  payload: z.record(z.any()).default({}),
  run_after: z.string().datetime().optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
});

const claimBody = z.object({
  queue_id: z.string().uuid(),
  worker: z.string().min(1).max(120),
  batch: z.number().int().min(1).max(50).default(1),
});

export async function queuesRoutes(app: FastifyInstance, cfg: Config) {
  // ---------- Queue admin ----------
  app.get('/admin/v1/queues', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return getSql(cfg)`
      select q.*, (select count(*) from admin.jobs j where j.queue_id = q.id and j.status = 'pending') as pending,
             (select count(*) from admin.jobs j where j.queue_id = q.id and j.status = 'dlq') as dlq
      from admin.queues q where project_id = ${q.project_id} order by name`;
  });

  app.post('/admin/v1/queues', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = queueBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.queues (project_id, name, max_concurrency, visibility_sec, max_attempts)
      values (${body.project_id}, ${body.name}, ${body.max_concurrency}, ${body.visibility_sec}, ${body.max_attempts})
      on conflict (project_id, name) do update set
        max_concurrency = excluded.max_concurrency,
        visibility_sec = excluded.visibility_sec,
        max_attempts = excluded.max_attempts
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'queue.upsert', target: body.name, detail: body });
    reply.code(201).send(row);
  });

  app.delete('/admin/v1/queues/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.queues where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'queue.delete', target: id });
    reply.code(204).send();
  });

  // ---------- Enqueue ----------
  app.post('/admin/v1/jobs', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = enqueueBody.parse(req.body);
    const sql = getSql(cfg);
    const [q] = await sql<any[]>`select project_id, max_attempts from admin.queues where id = ${body.queue_id}`;
    if (!q) { reply.code(404).send({ error: 'queue_not_found' }); return; }
    const [row] = await sql<any[]>`
      insert into admin.jobs (project_id, queue_id, payload, run_after, max_attempts)
      values (${q.project_id}, ${body.queue_id}, ${body.payload as any},
              ${body.run_after ?? new Date().toISOString()}, ${body.max_attempts ?? q.max_attempts})
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'job.enqueue', target: body.queue_id });
    reply.code(201).send(row);
  });

  // ---------- Claim (workers call this) ----------
  app.post('/admin/v1/jobs/claim', async (req) => {
    await requireAuth(req, cfg);
    const body = claimBody.parse(req.body);
    const sql = getSql(cfg);
    const [q] = await sql<any[]>`select visibility_sec from admin.queues where id = ${body.queue_id}`;
    if (!q) return [];
    return sql`select * from admin.claim_jobs(${body.queue_id}, ${body.worker}, ${body.batch}, ${q.visibility_sec})`;
  });

  // ---------- Ack / Nack ----------
  app.post('/admin/v1/jobs/:id/ack', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const body = z.object({ result: z.record(z.any()).optional() }).parse(req.body ?? {});
    await getSql(cfg)`update admin.jobs
      set status = 'succeeded', result = ${body.result ?? null as any}, updated_at = now(),
          visibility_until = null, claimed_by = null
      where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'job.ack', target: id });
    reply.code(204).send();
  });

  app.post('/admin/v1/jobs/:id/nack', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const body = z.object({ error: z.string().min(1).max(4000) }).parse(req.body);
    const sql = getSql(cfg);
    // Exponential backoff: 5s * 2^(attempts-1), cap 1h. If attempts >= max → DLQ.
    const [job] = await sql<any[]>`select attempts, max_attempts from admin.jobs where id = ${id}`;
    if (!job) { reply.code(404).send({ error: 'not_found' }); return; }
    if (job.attempts >= job.max_attempts) {
      await sql`update admin.jobs set status = 'dlq', last_error = ${body.error}, updated_at = now() where id = ${id}`;
    } else {
      const delay = Math.min(3600, 5 * Math.pow(2, Math.max(0, job.attempts - 1)));
      await sql`update admin.jobs
        set status = 'pending', last_error = ${body.error},
            run_after = now() + make_interval(secs => ${delay}),
            visibility_until = null, claimed_by = null, updated_at = now()
        where id = ${id}`;
    }
    await logAudit(cfg, { actor_id: actor.userId, action: 'job.nack', target: id, detail: { error: body.error.slice(0, 200) } });
    reply.code(204).send();
  });

  // Re-queue DLQ item
  app.post('/admin/v1/jobs/:id/requeue', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`update admin.jobs
      set status = 'pending', attempts = 0, run_after = now(), last_error = null, updated_at = now()
      where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'job.requeue', target: id });
    reply.code(204).send();
  });

  // ---------- Introspection ----------
  app.get('/admin/v1/jobs', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({
      project_id: z.string().uuid(),
      queue_id: z.string().uuid().optional(),
      status: z.enum(['pending', 'claimed', 'succeeded', 'failed', 'dlq']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    return getSql(cfg)`
      select id, queue_id, status, attempts, max_attempts, run_after, last_error, created_at, updated_at
      from admin.jobs
      where project_id = ${q.project_id}
        and (${q.queue_id ?? null}::uuid is null or queue_id = ${q.queue_id ?? null}::uuid)
        and (${q.status ?? null}::text is null or status::text = ${q.status ?? null})
      order by created_at desc limit ${q.limit}`;
  });

  // Sweep expired visibility (jobs whose worker died before ack).
  app.post('/admin/v1/jobs/sweep', async (req) => {
    await requireAuth(req, cfg);
    const r = await getSql(cfg)`
      update admin.jobs
      set status = 'pending', visibility_until = null, claimed_by = null,
          last_error = coalesce(last_error, 'visibility_timeout'), updated_at = now()
      where status = 'claimed' and visibility_until < now()
      returning id`;
    return { reclaimed: r.length };
  });
}
