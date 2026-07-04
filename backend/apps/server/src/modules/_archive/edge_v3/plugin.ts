// Phase 35 — Edge Functions v3 (hardened isolate runtime).
//
// Endpoints (gated by PLUTO_ENABLE_EDGE_V3=1):
//   POST /fn/v3/deployments             — create a new version { slug, code, timeout_ms?, memory_mb?, allow_hosts? }
//   GET  /fn/v3/deployments             — list active deployments
//   POST /fn/v3/deployments/:id/rollback — mark inactive
//   POST /fn/v3/invoke/:slug            — run active deployment
//   GET  /fn/v3/invocations?slug=&limit — recent invocation log

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { invokeIsolate } from "./isolate.js";

const CreateBody = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  code: z.string().min(1).max(500_000),
  timeout_ms: z.number().int().min(50).max(30_000).optional(),
  memory_mb: z.number().int().min(32).max(512).optional(),
  allow_hosts: z.array(z.string()).max(64).optional(),
  entry: z.string().max(80).optional(),
});

export const edgeV3Plugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_EDGE_V3 !== "1") {
    app.log.info("[edge3] disabled (set PLUTO_ENABLE_EDGE_V3=1 to enable)");
    return;
  }
  const wsFor = (req: { headers: Record<string, unknown> }) =>
    (req.headers["x-workspace-id"] as string) ?? null;

  app.post("/fn/v3/deployments", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const parse = CreateBody.safeParse(req.body);
    if (!parse.success) { reply.code(400); return { error: "bad_body", detail: parse.error.flatten() }; }
    const b = parse.data;
    const ws = wsFor(req);
    const v = await q<{ n: number | null }>(
      `select max(version) as n from public.fn_v3_deployments
       where workspace_id is not distinct from $1::uuid and slug=$2`,
      [ws, b.slug]);
    const version = (v.rows[0]?.n ?? 0) + 1;
    await q(
      `update public.fn_v3_deployments set active=false
       where workspace_id is not distinct from $1::uuid and slug=$2`,
      [ws, b.slug]);
    const r = await q<{ id: string }>(
      `insert into public.fn_v3_deployments
        (workspace_id, slug, version, code, entry, timeout_ms, memory_mb, allow_hosts, created_by)
       values ($1::uuid,$2,$3,$4,$5,$6,$7,$8::text[],$9::uuid)
       returning id`,
      [ws, b.slug, version, b.code, b.entry ?? "default",
       b.timeout_ms ?? 5000, b.memory_mb ?? 128, b.allow_hosts ?? [],
       req.auth?.user?.sub ?? null]);
    return { id: r.rows[0].id, slug: b.slug, version };
  });

  app.get("/fn/v3/deployments", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const r = await q(
      `select id, slug, version, timeout_ms, memory_mb, allow_hosts, active, created_at
       from public.fn_v3_deployments
       where workspace_id is not distinct from $1::uuid
       order by slug, version desc`, [ws]);
    return { deployments: r.rows };
  });

  app.post("/fn/v3/deployments/:id/rollback", { preHandler: requireWorkspaceAdmin },
    async (req) => {
      const id = (req.params as { id: string }).id;
      await q(`update public.fn_v3_deployments set active=false where id=$1::uuid`, [id]);
      return { ok: true };
    });

  app.post("/fn/v3/invoke/:slug", { preHandler: requireApiKey }, async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const ws = wsFor(req);
    const d = await q<{
      id: string; code: string; entry: string; timeout_ms: number;
      memory_mb: number; allow_hosts: string[];
    }>(
      `select id, code, entry, timeout_ms, memory_mb, allow_hosts
       from public.fn_v3_deployments
       where workspace_id is not distinct from $1::uuid and slug=$2 and active=true
       order by version desc limit 1`, [ws, slug]);
    if (!d.rows[0]) { reply.code(404); return { error: "no_active_deployment" }; }
    const dep = d.rows[0];
    const res = await invokeIsolate({
      code: dep.code,
      req: {
        method: req.method,
        url: req.url,
        headers: req.headers as Record<string, string>,
        body: req.body,
      },
      ctx: { workspace_id: ws, user_id: req.auth?.user?.sub ?? null },
      timeoutMs: dep.timeout_ms,
      memoryMb: dep.memory_mb,
      allowHosts: dep.allow_hosts,
    });
    await q(
      `insert into public.fn_v3_invocations
        (deployment_id, workspace_id, slug, ok, duration_ms, status, error, mem_peak_mb)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
      [dep.id, ws, slug, res.ok, res.durationMs, res.ok ? 200 : 500,
       res.error ?? null, res.memPeakMb]);
    if (!res.ok) { reply.code(500); return { error: res.error, logs: res.logs }; }
    return { result: res.result, logs: res.logs, duration_ms: res.durationMs };
  });

  app.get("/fn/v3/invocations", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const { slug, limit = "50" } = (req.query ?? {}) as { slug?: string; limit?: string };
    const lim = Math.min(500, Number(limit) || 50);
    const r = await q(
      `select id, slug, ok, duration_ms, status, error, started_at
       from public.fn_v3_invocations
       where workspace_id is not distinct from $1::uuid
         and ($2::text is null or slug=$2)
       order by started_at desc limit ${lim}`, [ws, slug ?? null]);
    return { invocations: r.rows };
  });
};
