// Phase 24 — Edge Functions v2: per-function secrets, cron schedules, invocation logs.
//
// Endpoints (gated by PLUTO_ENABLE_EDGE_V2=1):
//   GET/POST /fn/v2/secrets                    — list/upsert (workspace-scoped)
//   DELETE   /fn/v2/secrets/:id
//   GET/POST /fn/v2/schedules                  — list/create cron schedules
//   PATCH    /fn/v2/schedules/:id              — toggle active
//   DELETE   /fn/v2/schedules/:id
//   GET      /fn/v2/invocations?slug=&limit=   — invocation log
//   POST     /fn/v2/invocations                — record an invocation (internal helper)
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { recordUsage } from "../../lib/metering.js";

// Lightweight AES-256-GCM using a derived key. Persists as base64(iv|tag|ct).
function keyBytes(): Buffer {
  const raw = process.env.PLUTO_ENCRYPTION_KEY || process.env.JWT_SECRET || "pluto-dev-secret-change-me";
  return createHash("sha256").update(raw).digest();
}
function encrypt(plain: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}
function decryptSafe(b64: string): string | null {
  try {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = createDecipheriv("aes-256-gcm", keyBytes(), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch { return null; }
}

// Parse a minimal cron expression (mins hours dom mon dow) to next-run.
// Supports '*', '*/n', and integer literals — enough for the common cases.
function nextRun(cron: string, from = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/); if (parts.length !== 5) return null;
  const match = (val: number, field: string, max: number): boolean => {
    if (field === "*") return true;
    if (field.startsWith("*/")) { const n = Number(field.slice(2)); return n > 0 && val % n === 0; }
    return field.split(",").some(s => Number(s) === val);
  };
  const d = new Date(from.getTime() + 60_000); d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (match(d.getMinutes(), parts[0], 59) && match(d.getHours(), parts[1], 23) &&
        match(d.getDate(), parts[2], 31) && match(d.getMonth() + 1, parts[3], 12) &&
        match(d.getDay(), parts[4], 6)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export const edgeV2Plugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_EDGE_V2 !== "1") {
    app.log.info("[edge2] disabled (set PLUTO_ENABLE_EDGE_V2=1 to enable)");
    return;
  }
  const wsFor = (req: { headers: Record<string, unknown> }) =>
    (req.headers["x-workspace-id"] as string) ?? null;

  // --------------- Secrets ---------------
  app.get("/fn/v2/secrets", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const slug = (req.query as { slug?: string }).slug;
    const rows = await q(
      `select id, function_slug, name, created_at from public.fn_secrets
       where workspace_id is not distinct from $1::uuid
         and ($2::text is null or function_slug=$2)
       order by function_slug, name`, [ws, slug ?? null]);
    return { secrets: rows.rows };
  });

  app.post("/fn/v2/secrets", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const ws = wsFor(req);
    const b = z.object({
      function_slug: z.string().min(1).max(80),
      name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/),
      value: z.string().min(1).max(24576),
    }).parse(req.body);
    try {
      const r = await q(
        `insert into public.fn_secrets (workspace_id, function_slug, name, value_cipher)
         values ($1::uuid, $2, $3, $4)
         on conflict (workspace_id, function_slug, name)
         do update set value_cipher=excluded.value_cipher
         returning id, function_slug, name, created_at`,
        [ws, b.function_slug, b.name, encrypt(b.value)]);
      return { secret: r.rows[0] };
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });

  app.delete("/fn/v2/secrets/:id", { preHandler: requireWorkspaceAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await q(`delete from public.fn_secrets where id=$1::uuid`, [id]);
    return { ok: true };
  });

  // Internal helper used by function runner: return decrypted secrets bag.
  app.get("/fn/v2/secrets/:slug/bag", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const { slug } = req.params as { slug: string };
    const rows = await q(
      `select name, value_cipher from public.fn_secrets
       where workspace_id is not distinct from $1::uuid and function_slug=$2`, [ws, slug]);
    const bag: Record<string, string> = {};
    for (const r of rows.rows) { const v = decryptSafe(r.value_cipher); if (v !== null) bag[r.name] = v; }
    return { bag };
  });

  // --------------- Schedules ---------------
  app.get("/fn/v2/schedules", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const rows = await q(
      `select id, function_slug, cron, active, last_run_at, next_run_at, created_at
       from public.fn_schedules where workspace_id is not distinct from $1::uuid
       order by created_at desc`, [ws]);
    return { schedules: rows.rows };
  });

  app.post("/fn/v2/schedules", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const ws = wsFor(req);
    const b = z.object({ function_slug: z.string().min(1).max(80),
                          cron: z.string().min(1).max(120),
                          active: z.boolean().default(true) }).parse(req.body);
    const next = nextRun(b.cron);
    if (!next) { reply.code(400); return { error: "invalid_cron" }; }
    const r = await q(
      `insert into public.fn_schedules (workspace_id, function_slug, cron, active, next_run_at)
       values ($1::uuid, $2, $3, $4, $5) returning id, function_slug, cron, active, next_run_at, created_at`,
      [ws, b.function_slug, b.cron, b.active, next]);
    return { schedule: r.rows[0] };
  });

  app.patch("/fn/v2/schedules/:id", { preHandler: requireWorkspaceAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ active: z.boolean() }).parse(req.body);
    const r = await q(`update public.fn_schedules set active=$2 where id=$1::uuid
                       returning id, active`, [id, b.active]);
    return { schedule: r.rows[0] ?? null };
  });

  app.delete("/fn/v2/schedules/:id", { preHandler: requireWorkspaceAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    await q(`delete from public.fn_schedules where id=$1::uuid`, [id]);
    return { ok: true };
  });

  // --------------- Invocations ---------------
  app.get("/fn/v2/invocations", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const qparams = req.query as { slug?: string; limit?: string };
    const limit = Math.min(500, Number(qparams.limit ?? 100));
    const rows = await q(
      `select id, function_slug, trigger, status_code, duration_ms, cold_start, error, created_at
       from public.fn_invocations
       where workspace_id is not distinct from $1::uuid
         and ($2::text is null or function_slug=$2)
       order by created_at desc limit $3`, [ws, qparams.slug ?? null, limit]);
    return { invocations: rows.rows };
  });

  app.post("/fn/v2/invocations", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const b = z.object({
      function_slug: z.string().min(1).max(80),
      trigger: z.enum(["http","cron","manual"]).default("http"),
      status_code: z.number().int().optional(),
      duration_ms: z.number().int().nonnegative().optional(),
      cold_start: z.boolean().default(false),
      error: z.string().max(2000).optional(),
    }).parse(req.body);
    const r = await q(
      `insert into public.fn_invocations
       (workspace_id, function_slug, trigger, status_code, duration_ms, cold_start, error)
       values ($1::uuid, $2, $3, $4, $5, $6, $7) returning id, created_at`,
      [ws, b.function_slug, b.trigger, b.status_code ?? null, b.duration_ms ?? null, b.cold_start, b.error ?? null]);
    await recordUsage({ workspaceId: ws, metric: "function_invocations", quantity: 1,
                        billingLabel: b.function_slug, meta: { trigger: b.trigger, status_code: b.status_code } });
    return { ok: true, id: r.rows[0].id };
  });

  // ---------- Functions catalog ----------
  app.get("/fn/v2/functions", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const rows = await q(
      `select f.id, f.slug, f.display_name, f.runtime, f.entry, f.active, f.created_at, f.updated_at,
              (select count(*) from public.fn_schedules s
                 where s.workspace_id is not distinct from f.workspace_id and s.function_slug=f.slug) as schedules,
              (select count(*) from public.fn_secrets   x
                 where x.workspace_id is not distinct from f.workspace_id and x.function_slug=f.slug) as secrets,
              (select count(*) from public.fn_invocations i
                 where i.workspace_id is not distinct from f.workspace_id and i.function_slug=f.slug
                   and i.created_at > now() - interval '24 hours') as invocations_24h
       from public.fn_functions f
       where f.workspace_id is not distinct from $1::uuid
       order by f.updated_at desc`, [ws]);
    return { functions: rows.rows };
  });

  app.post("/fn/v2/functions", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const ws = wsFor(req);
    const b = z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      display_name: z.string().max(120).optional(),
      runtime: z.enum(["node20", "deno1", "bun1"]).default("node20"),
      entry: z.string().max(200).default("index.ts"),
      active: z.boolean().default(true),
    }).parse(req.body);
    try {
      const r = await q(
        `insert into public.fn_functions (workspace_id, slug, display_name, runtime, entry, active)
         values ($1::uuid, $2, $3, $4, $5, $6)
         on conflict (workspace_id, slug) do update
           set display_name=excluded.display_name, runtime=excluded.runtime,
               entry=excluded.entry, active=excluded.active, updated_at=now()
         returning id, slug, display_name, runtime, entry, active, created_at, updated_at`,
        [ws, b.slug, b.display_name ?? null, b.runtime, b.entry, b.active]);
      return { function: r.rows[0] };
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });

  app.delete("/fn/v2/functions/:slug", { preHandler: requireWorkspaceAdmin }, async (req) => {
    const ws = wsFor(req);
    const { slug } = req.params as { slug: string };
    await q(`delete from public.fn_functions where workspace_id is not distinct from $1::uuid and slug=$2`, [ws, slug]);
    return { ok: true };
  });

  // Test-invoke that records the invocation with a synthetic status.
  app.post("/fn/v2/functions/:slug/invoke", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const { slug } = req.params as { slug: string };
    const b = z.object({ payload: z.record(z.string(), z.unknown()).default({}),
                          simulate_error: z.boolean().default(false) }).parse(req.body ?? {});
    const t0 = Date.now();
    // MVP: echo runtime; a real runner would spawn an isolate here.
    await new Promise(r => setTimeout(r, 20 + Math.random() * 60));
    const status = b.simulate_error ? 500 : 200;
    const duration = Date.now() - t0;
    await q(
      `insert into public.fn_invocations (workspace_id, function_slug, trigger, status_code, duration_ms, cold_start, error)
       values ($1::uuid, $2, 'manual', $3, $4, false, $5)`,
      [ws, slug, status, duration, b.simulate_error ? "simulated_error" : null]);
    await recordUsage({ workspaceId: ws, metric: "function_invocations", quantity: 1,
                        billingLabel: slug, meta: { trigger: "manual", status_code: status } });
    return { ok: !b.simulate_error, status_code: status, duration_ms: duration,
             echoed: b.payload };
  });

  app.log.info("[edge2] Edge v2 enabled — /fn/v2/*");
};
