// Phase 55 — Edge v6 plugin.
// Endpoints (all under /fn/v6):
//   POST /fn/v6/host-fetch/allow         — set host allowlist for the workspace
//   POST /fn/v6/host-fetch               — proxy an outbound https fetch (WASM host import)
//   POST /fn/v6/do/:class/:id/call       — call a Durable Object method
//   GET  /fn/v6/do/:class/:id            — inspect DO state
//   POST /fn/v6/kv/put                   — put to shared backplane
//   GET  /fn/v6/kv/get                   — get from shared backplane
//   DELETE /fn/v6/kv                     — delete from shared backplane
//   POST /fn/v6/kv/replicate             — apply a remote LWW op (peer sync)
//   GET  /fn/v6/kv/keys                  — list keys with prefix
//
// Enabled via PLUTO_ENABLE_EDGE_V6=1.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../../../lib/apikey.js";
import { hostFetch, setAllowlist } from "../../../lib/host-fetch.js";
import { callDo, getState } from "../../../lib/durable-objects.js";
import { bpPut, bpGet, bpDelete, bpApplyRemote, bpKeys } from "../../../lib/kv-backplane.js";

const enabled = process.env.PLUTO_ENABLE_EDGE_V6 === "1";
const NS = /^[a-z0-9_\-]{1,64}$/;
const CLS = /^[a-z][a-z0-9_]{0,63}$/;

export async function edgeV6Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);
  app.log.info({ module: "edge_v6", phase: 55 }, "edge_v6 registered");

  // ---- host fetch --------------------------------------------------------
  app.post("/fn/v6/host-fetch/allow", async (req, reply) => {
    const p = z.object({ hosts: z.array(z.string().min(1).max(253)).max(50) }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const ws = req.auth?.workspaceId ?? "default";
    setAllowlist(ws, p.data.hosts);
    return { ok: true, hosts: p.data.hosts };
  });

  app.post("/fn/v6/host-fetch", async (req, reply) => {
    const p = z.object({
      url: z.string().url(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional(),
      headers: z.record(z.string()).optional(),
      body_base64: z.string().optional(),
      timeout_ms: z.number().int().positive().max(30_000).optional(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    try {
      const r = await hostFetch(req.auth?.workspaceId ?? "default", p.data);
      return r;
    } catch (e) {
      reply.code(403); return { error: (e as Error).message };
    }
  });

  // ---- durable objects ---------------------------------------------------
  app.post("/fn/v6/do/:cls/:id/call", async (req, reply) => {
    const params = z.object({ cls: z.string().regex(CLS), id: z.string().min(1).max(128) }).safeParse(req.params);
    const body = z.object({ method: z.string().min(1).max(64), args: z.unknown().optional() }).safeParse(req.body);
    if (!params.success || !body.success) { reply.code(400); return { error: "bad_request" }; }
    const r = await callDo(params.data.cls, params.data.id, body.data);
    if (!r.ok) { reply.code(400); return r; }
    return r;
  });

  app.get("/fn/v6/do/:cls/:id", async (req, reply) => {
    const params = z.object({ cls: z.string().regex(CLS), id: z.string().min(1) }).safeParse(req.params);
    if (!params.success) { reply.code(400); return { error: "bad_request" }; }
    return { class: params.data.cls, id: params.data.id, state: getState(params.data.cls, params.data.id) ?? null };
  });

  // ---- shared KV backplane ----------------------------------------------
  app.post("/fn/v6/kv/put", async (req, reply) => {
    const p = z.object({ ns: z.string().regex(NS), key: z.string().min(1).max(512), value: z.string().max(128 * 1024) }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const entry = await bpPut(p.data.ns, p.data.key, p.data.value);
    return { ok: true, entry };
  });

  app.get("/fn/v6/kv/get", async (req, reply) => {
    const p = z.object({ ns: z.string().regex(NS), key: z.string().min(1) }).safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    const e = bpGet(p.data.ns, p.data.key);
    if (!e) { reply.code(404); return { error: "not_found" }; }
    return e;
  });

  app.delete("/fn/v6/kv", async (req, reply) => {
    const p = z.object({ ns: z.string().regex(NS), key: z.string().min(1) }).safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    return { ok: true, removed: await bpDelete(p.data.ns, p.data.key) };
  });

  app.post("/fn/v6/kv/replicate", async (req, reply) => {
    const p = z.object({
      kind: z.enum(["put", "del"]),
      ns: z.string().regex(NS),
      key: z.string().min(1),
      entry: z.object({
        value: z.string(),
        version: z.number().int().positive(),
        updated_at: z.number().int().positive(),
        region: z.string().min(1),
      }).optional(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const r = bpApplyRemote(p.data);
    return { ok: true, ...r };
  });

  app.get("/fn/v6/kv/keys", async (req, reply) => {
    const p = z.object({ ns: z.string().regex(NS), prefix: z.string().max(256).optional() }).safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    return { keys: bpKeys(p.data.ns, p.data.prefix ?? "") };
  });
}

export default edgeV6Plugin;
