// Phase 17 — Scaling & Performance
// Endpoints:
//   POST /queue/v1/:queue/enqueue         → durable job enqueue
//   POST /queue/v1/:queue/dequeue         → worker claim (pluto_jobs role)
//   POST /queue/v1/jobs/:id/complete      → mark done / failed with retry
//   GET  /queue/v1/jobs                   → list with filters
//   GET  /queue/v1/stats                  → per-queue counters
//   GET  /cache/v1/:key / PUT / DELETE    → workspace-scoped KV cache
//   GET  /admin/v1/rate-limits            → policy CRUD (admin)
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireAdmin } from "../../lib/apikey.js";

// In-memory throttle tracker keyed by `${scope}:${route}:${identity}`.
// Exposed via getRateLimitSnapshot() so integration health can surface
// per-key throttle status without hitting the database.
type Bucket = { hits: number; resetAt: number; max: number; window_sec: number; blocked: number };
const throttleBuckets = new Map<string, Bucket>();

export function getRateLimitSnapshot(): Array<{
  key: string; hits: number; max: number; remaining: number;
  window_sec: number; reset_in_sec: number; blocked: number;
}> {
  const now = Date.now();
  const out: ReturnType<typeof getRateLimitSnapshot> = [];
  for (const [key, b] of throttleBuckets.entries()) {
    if (b.resetAt < now) { throttleBuckets.delete(key); continue; }
    out.push({
      key, hits: b.hits, max: b.max, remaining: Math.max(0, b.max - b.hits),
      window_sec: b.window_sec, reset_in_sec: Math.max(0, Math.round((b.resetAt - now) / 1000)),
      blocked: b.blocked,
    });
  }
  return out.sort((a, b) => b.hits - a.hits).slice(0, 50);
}

function bump(key: string, max: number, window_sec: number) {
  const now = Date.now();
  let b = throttleBuckets.get(key);
  if (!b || b.resetAt < now) b = { hits: 0, resetAt: now + window_sec * 1000, max, window_sec, blocked: 0 };
  b.hits += 1;
  const allowed = b.hits <= max;
  if (!allowed) b.blocked += 1;
  throttleBuckets.set(key, b);
  return { allowed, ...b, remaining: Math.max(0, max - b.hits), reset_in_sec: Math.max(0, Math.round((b.resetAt - now) / 1000)) };
}


const enqueueBody = z.object({
  payload: z.record(z.unknown()).default({}),
  run_at: z.string().datetime().optional(),
  max_attempts: z.number().int().min(1).max(50).default(5),
});
const completeBody = z.object({
  status: z.enum(["done", "failed"]),
  result: z.record(z.unknown()).optional(),
  error: z.string().max(2000).optional(),
  retry_in_sec: z.number().int().min(0).max(86_400).optional(),
});
const policyBody = z.object({
  route: z.string().min(1).max(200),
  scope: z.enum(["ip", "user", "workspace", "key"]).default("ip"),
  max_hits: z.number().int().min(1).max(1_000_000),
  window_sec: z.number().int().min(1).max(86_400),
  action: z.enum(["block", "shadow"]).default("block"),
});

export const scalingPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_SCALING !== "1") {
    app.log.info({ module: "scaling" }, "scaling disabled (set PLUTO_ENABLE_SCALING=1)");
    return;
  }
  app.log.info({ module: "scaling", phase: "17" }, "scaling registered");

  // ---- Queue ----
  app.post("/queue/v1/:queue/enqueue", { preHandler: requireApiKey }, async (req) => {
    const { queue } = req.params as { queue: string };
    const body = enqueueBody.parse(req.body);
    const r = await q<{ id: string }>(
      `insert into public.queue_jobs (workspace_id, queue, payload, run_at, max_attempts)
       values ($1,$2,$3::jsonb, coalesce($4::timestamptz, now()), $5) returning id`,
      [req.auth!.workspaceId ?? null, queue, JSON.stringify(body.payload), body.run_at ?? null, body.max_attempts]);
    return { id: r.rows[0]!.id, queue, status: "pending" };
  });

  app.post("/queue/v1/:queue/dequeue", { preHandler: requireApiKey }, async (req, reply) => {
    if (req.auth!.apiKey !== "service_role") return reply.code(403).send({ error: "service_role_required" });
    const { queue } = req.params as { queue: string };
    const worker = (req.headers["x-worker-id"] as string) || `w-${process.pid}`;
    const r = await q(
      `with next as (
         select id from public.queue_jobs
         where queue=$1 and status='pending' and run_at<=now()
         order by run_at asc for update skip locked limit 1)
       update public.queue_jobs j set status='running', attempts=attempts+1,
         locked_by=$2, locked_at=now(), updated_at=now()
       from next where j.id=next.id
       returning j.id, j.payload, j.attempts, j.max_attempts, j.workspace_id`,
      [queue, worker]);
    return { job: r.rows[0] ?? null };
  });

  app.post("/queue/v1/jobs/:id/complete", { preHandler: requireApiKey }, async (req, reply) => {
    if (req.auth!.apiKey !== "service_role") return reply.code(403).send({ error: "service_role_required" });
    const { id } = req.params as { id: string };
    const b = completeBody.parse(req.body);
    if (b.status === "done") {
      await q(`update public.queue_jobs set status='done', result=$2::jsonb, updated_at=now(), locked_by=null
               where id=$1`, [id, JSON.stringify(b.result ?? {})]);
    } else {
      await q(
        `update public.queue_jobs set
           status = case when attempts >= max_attempts then 'dead' else 'pending' end,
           last_error = $2,
           run_at = now() + make_interval(secs => coalesce($3::int, least(60, attempts*attempts*5))),
           locked_by = null, updated_at = now()
         where id=$1`,
        [id, b.error ?? null, b.retry_in_sec ?? null]);
    }
    return { ok: true };
  });

  app.get("/queue/v1/jobs", { preHandler: requireApiKey }, async (req) => {
    const qs = req.query as { queue?: string; status?: string; limit?: string };
    const limit = Math.min(Number(qs.limit ?? 50), 200);
    const r = await q(
      `select id, queue, status, attempts, max_attempts, run_at, last_error, created_at
       from public.queue_jobs
       where ($1::text is null or queue=$1) and ($2::text is null or status=$2)
         and ($3::uuid is null or workspace_id=$3)
       order by created_at desc limit $4`,
      [qs.queue ?? null, qs.status ?? null, req.auth!.workspaceId ?? null, limit]);
    return { jobs: r.rows, total: r.rows.length };
  });

  app.get("/queue/v1/stats", { preHandler: requireApiKey }, async (req) => {
    const r = await q(
      `select queue, status, count(*)::int as n from public.queue_jobs
       where ($1::uuid is null or workspace_id=$1)
       group by queue, status order by queue`, [req.auth!.workspaceId ?? null]);
    return { rows: r.rows };
  });

  // ---- Cache ----
  app.get("/cache/v1/:key", { preHandler: requireApiKey }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const r = await q<{ value: unknown; expires_at: string | null }>(
      `select value, expires_at from public.cache_entries
       where workspace_id=$1 and key=$2
         and (expires_at is null or expires_at > now())`,
      [req.auth!.workspaceId ?? null, key]);
    if (!r.rows[0]) return reply.code(404).send({ error: "miss" });
    return r.rows[0];
  });

  app.put("/cache/v1/:key", { preHandler: requireApiKey }, async (req) => {
    const { key } = req.params as { key: string };
    const body = z.object({ value: z.unknown(), ttl_sec: z.number().int().min(1).max(86_400 * 30).optional() }).parse(req.body);
    await q(
      `insert into public.cache_entries (workspace_id, key, value, expires_at)
       values ($1,$2,$3::jsonb, case when $4::int is null then null else now() + make_interval(secs => $4::int) end)
       on conflict (workspace_id, key) do update
         set value=excluded.value, expires_at=excluded.expires_at`,
      [req.auth!.workspaceId ?? null, key, JSON.stringify(body.value), body.ttl_sec ?? null]);
    return { ok: true };
  });

  app.delete("/cache/v1/:key", { preHandler: requireApiKey }, async (req) => {
    const { key } = req.params as { key: string };
    await q(`delete from public.cache_entries where workspace_id=$1 and key=$2`,
      [req.auth!.workspaceId ?? null, key]);
    return { ok: true };
  });

  // ---- Rate-limit policies (admin) ----
  app.get("/admin/v1/rate-limits", { preHandler: [requireApiKey, async (req, reply) => { requireAdmin(req, reply); }] },
    async (req) => {
      const r = await q(`select * from public.rate_limit_policies
                         where ($1::uuid is null or workspace_id=$1)
                         order by route`, [req.auth!.workspaceId ?? null]);
      return { policies: r.rows };
    });

  app.post("/admin/v1/rate-limits", { preHandler: [requireApiKey, async (req, reply) => { requireAdmin(req, reply); }] },
    async (req) => {
      const b = policyBody.parse(req.body);
      const r = await q(
        `insert into public.rate_limit_policies (workspace_id, route, scope, max_hits, window_sec, action)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (workspace_id, route, scope) do update set
           max_hits=excluded.max_hits, window_sec=excluded.window_sec,
           action=excluded.action, updated_at=now()
         returning *`,
        [req.auth!.workspaceId ?? null, b.route, b.scope, b.max_hits, b.window_sec, b.action]);
      return r.rows[0];
    });

  app.delete("/admin/v1/rate-limits/:id", { preHandler: [requireApiKey, async (req, reply) => { requireAdmin(req, reply); }] },
    async (req) => {
      const { id } = req.params as { id: string };
      await q(`delete from public.rate_limit_policies where id=$1`, [id]);
      return { ok: true };
    });

  // ---- Rate-limit test harness ---------------------------------------
  // POST /admin/v1/rate-limits/test — increments the in-memory counter
  // for a (route, scope, identity) tuple against the DB policy so admins
  // can verify a policy without generating real traffic.
  app.post("/admin/v1/rate-limits/test",
    { preHandler: [requireApiKey, async (req, reply) => { requireAdmin(req, reply); }] },
    async (req, reply) => {
      const body = z.object({
        route: z.string().min(1),
        scope: z.enum(["ip", "user", "workspace", "key"]).default("ip"),
        identity: z.string().min(1).default("dashboard-test"),
        hits: z.number().int().min(1).max(1000).default(1),
      }).parse(req.body);
      const pol = (await q<{ max_hits: number; window_sec: number; action: string }>(
        `select max_hits, window_sec, action from public.rate_limit_policies
         where route=$1 and scope=$2
           and (workspace_id is null or workspace_id=$3) order by workspace_id nulls last limit 1`,
        [body.route, body.scope, req.auth!.workspaceId ?? null])).rows[0];
      if (!pol) return reply.code(404).send({ error: "no_policy_for_route" });
      const key = `${body.scope}:${body.route}:${body.identity}`;
      let last: ReturnType<typeof bump> | null = null;
      for (let i = 0; i < body.hits; i++) last = bump(key, pol.max_hits, pol.window_sec);
      return {
        route: body.route, scope: body.scope, identity: body.identity, policy: pol,
        result: last, key,
      };
    });

  app.get("/admin/v1/rate-limits/status",
    { preHandler: [requireApiKey, async (req, reply) => { requireAdmin(req, reply); }] },
    async () => ({ snapshot: getRateLimitSnapshot() }));

  // ---- Queue test job + worker --------------------------------------
  // POST /queue/v1/test — enqueues a demo job onto the `pluto.test`
  // queue. Payload defaults to a timestamped echo; the in-process
  // worker (see startQueueWorker) will pick it up and mark it done.
  app.post("/queue/v1/test", { preHandler: requireApiKey }, async (req) => {
    const body = z.object({
      echo: z.string().max(500).default(`ping @ ${new Date().toISOString()}`),
      delay_sec: z.number().int().min(0).max(60).default(0),
    }).parse((req.body ?? {}) as Record<string, unknown>);
    const runAt = new Date(Date.now() + body.delay_sec * 1000).toISOString();
    const r = await q<{ id: string }>(
      `insert into public.queue_jobs (workspace_id, queue, payload, run_at, max_attempts)
       values ($1,'pluto.test',$2::jsonb,$3::timestamptz,3) returning id`,
      [req.auth!.workspaceId ?? null, JSON.stringify({ echo: body.echo }), runAt]);
    return { id: r.rows[0]!.id, queue: "pluto.test", run_at: runAt, status: "pending" };
  });
};

// ---- Durable queue worker ---------------------------------------------
// Started from server.ts when PLUTO_QUEUE_WORKER=1. Polls the DB for
// `pluto.test` and `default` jobs, invokes the registered handler, and
// completes / retries via update statements (same SKIP LOCKED contract
// the /queue/v1/:queue/dequeue endpoint uses). Safe to run alongside
// external workers — advisory locking is done in the SELECT.
type Handler = (payload: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
const handlers = new Map<string, Handler>([
  ["pluto.test", async (payload) => ({ echoed: payload.echo, at: new Date().toISOString() })],
]);
export function registerQueueHandler(queue: string, fn: Handler) { handlers.set(queue, fn); }

export function startQueueWorker(log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): () => void {
  const workerId = `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      let claimed = false;
      for (const queue of handlers.keys()) {
        try {
          const r = await q<{ id: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }>(
            `with next as (
               select id from public.queue_jobs
               where queue=$1 and status='pending' and run_at<=now()
               order by run_at asc for update skip locked limit 1)
             update public.queue_jobs j set status='running', attempts=attempts+1,
               locked_by=$2, locked_at=now(), updated_at=now()
             from next where j.id=next.id
             returning j.id, j.payload, j.attempts, j.max_attempts`,
            [queue, workerId]);
          const job = r.rows[0];
          if (!job) continue;
          claimed = true;
          try {
            const result = await handlers.get(queue)!(job.payload);
            await q(`update public.queue_jobs set status='done', result=$2::jsonb,
                     locked_by=null, updated_at=now() where id=$1`,
              [job.id, JSON.stringify(result ?? { ok: true })]);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const done = job.attempts >= job.max_attempts;
            await q(
              `update public.queue_jobs set
                 status = case when $3 then 'dead' else 'pending' end,
                 last_error=$2,
                 run_at = now() + make_interval(secs => least(60, attempts*attempts*5)),
                 locked_by=null, updated_at=now() where id=$1`,
              [job.id, msg, done]);
          }
        } catch (e) {
          log.error({ err: (e as Error).message, queue }, "worker error");
        }
      }
      await new Promise((r) => setTimeout(r, claimed ? 50 : 1000));
    }
  };
  log.info({ workerId, queues: Array.from(handlers.keys()) }, "queue worker started");
  void tick();
  return () => { stopped = true; };
}

