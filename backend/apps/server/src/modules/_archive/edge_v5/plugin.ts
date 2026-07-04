// Phase 53 — Edge v5 plugin.
//
// Endpoints (all under /fn/v5):
//   POST /fn/v5/modules            — register a WASM module (base64 body)
//   GET  /fn/v5/modules            — list registered modules
//   POST /fn/v5/deployments        — deploy a module to a region with warm pool config
//   POST /fn/v5/invoke             — invoke by (module, version) + client region hint
//   POST /fn/v5/domains            — attach a custom hostname to a module
//   GET  /fn/v5/domains            — list custom domains
//
// Enabled via PLUTO_ENABLE_EDGE_V5=1.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../../lib/apikey.js";
import { registerModule, getModule, listModules, hashWasm } from "../../lib/wasm-registry.js";
import { configure, acquire, release, stats, poolKey } from "../../lib/warm-pool.js";
import { pickDeployment, type Deployment } from "../../lib/region-router.js";
import { kvPut, kvGet, kvDelete, kvList } from "../../lib/edge-kv.js";
import { bind as qbind, enqueue as qenqueue, drain as qdrain, pending as qpending, subscribers as qsubs } from "../../lib/edge-queue.js";


const enabled = process.env.PLUTO_ENABLE_EDGE_V5 === "1";
const NAME = /^[a-z][a-z0-9_\-]{0,63}$/;
const REGION = /^[a-z]{2}-[a-z]+(?:-\d+)?$/;
const HOST = /^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?)+$/i;

// In-memory registry (mirrors DB). Deployments and domains keyed by workspace.
const deployments = new Map<string, Deployment[]>();
const domains = new Map<string, { hostname: string; module: string }[]>();

export async function edgeV5Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);
  app.log.info({ module: "edge_v5", phase: 53 }, "edge_v5 registered");

  app.post("/fn/v5/modules", async (req, reply) => {
    const p = z.object({
      name: z.string().regex(NAME),
      version: z.number().int().positive().default(1),
      entry: z.string().default("handler"),
      wasm_base64: z.string().min(4),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const bytes = new Uint8Array(Buffer.from(p.data.wasm_base64, "base64"));
    if (bytes.byteLength > 20 * 1024 * 1024) { reply.code(413); return { error: "module_too_large" }; }
    const mod = registerModule({ name: p.data.name, version: p.data.version, entry: p.data.entry, wasm: bytes });
    return { id: mod.id, name: mod.name, version: mod.version, sha256: mod.sha256, size_bytes: mod.size_bytes };
  });

  app.get("/fn/v5/modules", async () => ({
    modules: listModules().map((m) => ({ id: m.id, name: m.name, version: m.version, sha256: m.sha256, size_bytes: m.size_bytes })),
  }));

  app.post("/fn/v5/deployments", async (req, reply) => {
    const p = z.object({
      module: z.string().regex(NAME),
      version: z.number().int().positive().default(1),
      region: z.string().regex(REGION),
      min_warm: z.number().int().min(0).max(50).default(1),
      max_warm: z.number().int().min(1).max(200).default(4),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const mod = getModule(p.data.module, p.data.version);
    if (!mod) { reply.code(404); return { error: "module_not_found" }; }
    const ws = (req.auth?.workspaceId ?? "default");
    const list = deployments.get(ws) ?? [];
    const dep: Deployment = { region: p.data.region, module: p.data.module, version: p.data.version, status: "active" };
    const existing = list.findIndex((d) => d.region === dep.region && d.module === dep.module && d.version === dep.version);
    if (existing >= 0) list[existing] = dep; else list.push(dep);
    deployments.set(ws, list);
    configure(poolKey(dep.module, dep.version, dep.region), p.data.min_warm, p.data.max_warm);
    return { ok: true, deployment: dep, pool: stats(poolKey(dep.module, dep.version, dep.region)) };
  });

  app.post("/fn/v5/invoke", async (req, reply) => {
    const p = z.object({
      module: z.string().regex(NAME),
      version: z.number().int().positive().default(1),
      client_region: z.string().regex(REGION).default("us-east"),
      payload: z.unknown().optional(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const ws = (req.auth?.workspaceId ?? "default");
    const list = (deployments.get(ws) ?? []).filter((d) => d.module === p.data.module && d.version === p.data.version);
    const chosen = pickDeployment(list, p.data.client_region);
    if (!chosen) { reply.code(404); return { error: "no_deployment" }; }
    const key = poolKey(chosen.module, chosen.version, chosen.region);
    const t0 = Date.now();
    const { instance, cold } = acquire(key);
    // Simulated execution — a real Worker would invoke WebAssembly.instantiate here.
    const duration_ms = Date.now() - t0;
    release(key, instance);
    return {
      ok: true,
      region: chosen.region,
      cold,
      instance_id: instance.id,
      duration_ms,
      echo: p.data.payload ?? null,
      pool: stats(key),
    };
  });

  app.post("/fn/v5/domains", async (req, reply) => {
    const p = z.object({
      hostname: z.string().regex(HOST).max(253),
      module: z.string().regex(NAME),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const ws = (req.auth?.workspaceId ?? "default");
    const list = domains.get(ws) ?? [];
    if (list.some((d) => d.hostname === p.data.hostname)) { reply.code(409); return { error: "hostname_taken" }; }
    list.push({ hostname: p.data.hostname.toLowerCase(), module: p.data.module });
    domains.set(ws, list);
    return { ok: true, hostname: p.data.hostname, cert_status: "pending", verify_txt: `pluto-verify=${hashWasm(new TextEncoder().encode(p.data.hostname)).slice(0, 24)}` };
  });

  app.get("/fn/v5/domains", async (req) => {
    const ws = (req.auth?.workspaceId ?? "default");
    return { domains: domains.get(ws) ?? [] };
  });

  // ---- KV: per-function key/value ----------------------------------------
  app.post("/fn/v5/kv/put", async (req, reply) => {
    const p = z.object({
      module: z.string().regex(NAME),
      key: z.string().min(1).max(512),
      value: z.string().max(64 * 1024),
      ttl_ms: z.number().int().positive().max(30 * 24 * 60 * 60_000).optional(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const ws = (req.auth?.workspaceId ?? "default");
    kvPut(ws, p.data.module, p.data.key, p.data.value, p.data.ttl_ms);
    return { ok: true };
  });

  app.get("/fn/v5/kv/get", async (req, reply) => {
    const p = z.object({ module: z.string().regex(NAME), key: z.string().min(1) }).safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const ws = (req.auth?.workspaceId ?? "default");
    const v = kvGet(ws, p.data.module, p.data.key);
    if (v === null) { reply.code(404); return { error: "not_found" }; }
    return { key: p.data.key, value: v };
  });

  app.delete("/fn/v5/kv", async (req, reply) => {
    const p = z.object({ module: z.string().regex(NAME), key: z.string().min(1) }).safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const ws = (req.auth?.workspaceId ?? "default");
    return { ok: true, removed: kvDelete(ws, p.data.module, p.data.key) };
  });

  app.get("/fn/v5/kv/list", async (req, reply) => {
    const p = z.object({ module: z.string().regex(NAME), prefix: z.string().max(256).optional() }).safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const ws = (req.auth?.workspaceId ?? "default");
    return { keys: kvList(ws, p.data.module, p.data.prefix ?? "") };
  });

  // ---- Queue triggers ----------------------------------------------------
  app.post("/fn/v5/queues/bind", async (req, reply) => {
    const p = z.object({
      queue: z.string().regex(NAME),
      module: z.string().regex(NAME),
      version: z.number().int().positive().default(1),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    qbind(p.data.queue, { module: p.data.module, version: p.data.version });
    return { ok: true, subscribers: qsubs(p.data.queue) };
  });

  app.post("/fn/v5/queues/enqueue", async (req, reply) => {
    const p = z.object({ queue: z.string().regex(NAME), body: z.unknown() }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const job = qenqueue(p.data.queue, p.data.body);
    return { ok: true, job, pending: qpending(p.data.queue) };
  });

  app.post("/fn/v5/queues/drain", async (req, reply) => {
    const p = z.object({ queue: z.string().regex(NAME), max: z.number().int().min(1).max(1000).default(100) }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    // Simulated dispatcher — always succeeds; real deployment invokes the WASM handler.
    const result = await qdrain(p.data.queue, async () => ({ ok: true }), p.data.max);
    return { ok: true, ...result, pending: qpending(p.data.queue) };
  });

  // ---- Streaming response (chunked SSE-style) ---------------------------
  app.get("/fn/v5/stream", async (req, reply) => {
    const chunks = Math.min(Number((req.query as { chunks?: string }).chunks ?? 5), 100);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-edge-streaming": "v5",
    });
    for (let i = 0; i < chunks; i++) {
      reply.raw.write(`data: ${JSON.stringify({ i, ts: Date.now() })}\n\n`);
      await new Promise((r) => setTimeout(r, 5));
    }
    reply.raw.end();
  });
}

export default edgeV5Plugin;

