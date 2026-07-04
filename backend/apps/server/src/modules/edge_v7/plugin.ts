// Phase 56 — Edge v7 plugin: replicated queues, cron triggers, signed bindings.
// Mount prefix `/fn/v7`. Enabled via PLUTO_ENABLE_EDGE_V7=1.
//
// Auth: every route requires an API key. `bindings/allowlist`, `bindings/issue`,
// `cron/upsert`, and `cron/tick` additionally require `x-role: admin` header —
// they can mint credentials or trigger runs. Read-only inspection endpoints
// (`queues/pending`, `queues/dlq`, `cron/list`) accept any API key.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../../lib/apikey.js";
import { publish, poll, pendingMessages, deadLetter, applyRemote, configureReplicated,
  type QueueMessage } from "../../lib/replicated-queue.js";
import { upsertSchedule, removeSchedule, listSchedules, tick } from "../../lib/cron-scheduler.js";
import { issueBinding, verifyAndOpen, setBindingAllowlist } from "../../lib/signed-bindings.js";

const enabled = process.env.PLUTO_ENABLE_EDGE_V7 === "1";
const NAME = /^[a-z][a-z0-9_\-]{0,63}$/;

function requireAdmin(req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply): boolean {
  if ((req.headers["x-role"] as string) !== "admin") { reply.code(403); reply.send({ error: "admin_required" }); return false; }
  return true;
}

export async function edgeV7Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);
  app.log.info({ module: "edge_v7", phase: 56 }, "edge_v7 registered");
  configureReplicated(process.env.PLUTO_REGION ?? "local");

  // ---- replicated queues -------------------------------------------------
  app.post("/fn/v7/queues/publish", async (req, reply) => {
    const p = z.object({ queue: z.string().regex(NAME), body: z.unknown(), id: z.string().max(128).optional() }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const msg = await publish(p.data.queue, p.data.body, { id: p.data.id });
    return { ok: true, message: msg, pending: pendingMessages(p.data.queue) };
  });

  app.post("/fn/v7/queues/replicate", async (req, reply) => {
    const p = z.object({
      id: z.string(), queue: z.string().regex(NAME), body: z.unknown(),
      attempts: z.number().int().nonnegative(), next_attempt_at: z.number().int().positive(),
      region: z.string().min(1), enqueued_at: z.number().int().positive(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    return { ok: true, ...applyRemote(p.data as QueueMessage) };
  });

  app.post("/fn/v7/queues/poll", async (req, reply) => {
    const p = z.object({ queue: z.string().regex(NAME), max: z.number().int().min(1).max(1000).default(50) }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    const r = await poll(p.data.queue, async () => ({ ok: true }), p.data.max);
    return { ok: true, ...r, pending: pendingMessages(p.data.queue), dlq: deadLetter(p.data.queue).length };
  });

  app.get("/fn/v7/queues/pending", async (req) => {
    const q = (req.query as { queue?: string }).queue ?? "";
    return { queue: q, pending: pendingMessages(q), dlq: deadLetter(q).length };
  });

  app.get("/fn/v7/queues/dlq", async (req) => {
    const q = (req.query as { queue?: string }).queue ?? "";
    return { queue: q, messages: deadLetter(q) };
  });

  // ---- cron --------------------------------------------------------------
  app.post("/fn/v7/cron/upsert", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = z.object({
      id: z.string().regex(NAME), expr: z.string().min(9).max(64),
      module: z.string().regex(NAME), version: z.number().int().positive().default(1),
      misfire_grace_ms: z.number().int().positive().max(24 * 60 * 60_000).default(5 * 60_000),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    try { return { ok: true, schedule: upsertSchedule(p.data) }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });

  app.delete("/fn/v7/cron/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const removed = removeSchedule((req.params as { id: string }).id);
    if (!removed) { reply.code(404); return { error: "not_found" }; }
    return { ok: true };
  });

  app.get("/fn/v7/cron/list", async () => ({ schedules: listSchedules() }));

  app.post("/fn/v7/cron/tick", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = z.object({ now: z.number().int().positive().optional() }).safeParse(req.body ?? {});
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    return { ok: true, fires: tick(p.data.now ?? Date.now()) };
  });

  // ---- signed bindings ---------------------------------------------------
  app.post("/fn/v7/bindings/allowlist", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = z.object({ module: z.string().regex(NAME), names: z.array(z.string().min(1).max(64)).max(50) }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    setBindingAllowlist(req.auth?.workspaceId ?? "default", p.data.module, p.data.names);
    return { ok: true, module: p.data.module, names: p.data.names };
  });

  app.post("/fn/v7/bindings/issue", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const p = z.object({
      name: z.string().min(1).max(64), value: z.string().min(1).max(16 * 1024),
      ttl_ms: z.number().int().positive().max(15 * 60_000).optional(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    const env = issueBinding(req.auth?.workspaceId ?? "default", p.data.name, p.data.value, p.data.ttl_ms);
    return { ok: true, envelope: env };
  });

  app.post("/fn/v7/bindings/verify", async (req, reply) => {
    const p = z.object({
      module: z.string().regex(NAME),
      envelope: z.object({
        name: z.string(), value_b64: z.string(),
        exp: z.number().int().positive(), sig: z.string().regex(/^[0-9a-f]+$/i),
      }),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    const r = verifyAndOpen(req.auth?.workspaceId ?? "default", p.data.module, p.data.envelope);
    if (!r.ok) { reply.code(403); return r; }
    return r;
  });
}

export default edgeV7Plugin;
