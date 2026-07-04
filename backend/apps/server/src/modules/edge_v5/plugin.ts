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
}

export default edgeV5Plugin;
