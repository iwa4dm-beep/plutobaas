// AI & Vector — Phase 16.1+
//
// Providers are validated against a strict allow-list. Embeddings and
// chat proxy through the Lovable AI Gateway (default) or OpenAI, using
// server-side keys that never leave this process. Every call records a
// row in public.ai_usage for cost + latency + status tracking.
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { DEFAULT_VECTOR_ALLOW, type AiDriver } from "./types.js";

const ALLOWED_DRIVERS: readonly AiDriver[] = ["lovable", "openai", "voyage", "cohere", "anthropic"] as const;

function readAllow(): string[] {
  const raw = process.env.PLUTO_AI_VECTOR_ALLOW;
  if (!raw) return [...DEFAULT_VECTOR_ALLOW];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

type Provider = {
  base_url: string; key: string | undefined;
  chat_path: string; embed_path: string;
};

// Resolve driver → real HTTP endpoint. Lovable AI Gateway is OpenAI-compatible.
function driverEndpoints(driver: AiDriver): Provider {
  switch (driver) {
    case "openai":
      return { base_url: "https://api.openai.com/v1", key: process.env.OPENAI_API_KEY,
               chat_path: "/chat/completions", embed_path: "/embeddings" };
    case "lovable":
    default:
      return { base_url: process.env.LOVABLE_AI_URL ?? "https://ai.gateway.lovable.dev/v1",
               key: process.env.LOVABLE_AI_KEY ?? process.env.LOVABLE_API_KEY,
               chat_path: "/chat/completions", embed_path: "/embeddings" };
  }
}

async function record(req: FastifyRequest, opts: {
  provider_slug: string; model: string; endpoint: "embeddings"|"chat"|"vector.search";
  tokens_in?: number; tokens_out?: number; latency_ms: number; status_code: number;
  cost_usd_micro?: number; error?: string | null;
}) {
  await q(`insert into public.ai_usage
    (workspace_id, actor_id, provider_slug, model, endpoint, tokens_in, tokens_out,
     latency_ms, status_code, cost_usd_micro, request_id, error)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [req.auth!.workspaceId, req.auth?.user?.sub ?? null, opts.provider_slug, opts.model,
     opts.endpoint, opts.tokens_in ?? 0, opts.tokens_out ?? 0, opts.latency_ms,
     opts.status_code, opts.cost_usd_micro ?? 0, req.id, opts.error ?? null]).catch(() => {});
}

async function resolveDriver(req: FastifyRequest, providerSlug?: string): Promise<{ slug: string; driver: AiDriver }> {
  if (!providerSlug) {
    // fall back to lovable if no per-workspace provider configured.
    const row = await q<{ slug: string; driver: AiDriver }>(
      `select slug, driver from public.ai_providers where workspace_id=$1 and enabled=true
       order by created_at asc limit 1`, [req.auth!.workspaceId]);
    if (row.rows[0]) return row.rows[0];
    return { slug: "lovable", driver: "lovable" };
  }
  const row = await q<{ slug: string; driver: AiDriver }>(
    `select slug, driver from public.ai_providers where workspace_id=$1 and slug=$2 and enabled=true`,
    [req.auth!.workspaceId, providerSlug]);
  if (!row.rows[0]) throw new Error(`provider '${providerSlug}' not found or disabled`);
  return row.rows[0];
}

function requireService(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.auth?.apiKey !== "service_role") { reply.code(403).send({ error: "service_role_required" }); return false; }
  return true;
}

export const aiPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_AI !== "1") {
    app.log.info({ module: "ai" }, "ai disabled (set PLUTO_ENABLE_AI=1 to enable)");
    return;
  }
  const gatewayReady = !!(process.env.LOVABLE_AI_KEY || process.env.LOVABLE_API_KEY || process.env.OPENAI_API_KEY);
  app.log.info({ module: "ai", phase: "16.3", gatewayReady }, "ai registered (real handlers)");

  app.get("/ai/v1/status", async () => ({
    module: "ai", phase: "16.3", gateway_ready: gatewayReady,
    vector_allow: readAllow(), drivers: ALLOWED_DRIVERS,
  }));

  // ---- Providers CRUD ----
  app.get("/ai/v1/providers", async (req) => {
    const r = await q(`select id, slug, driver, default_chat_model, default_embed_model,
                       enabled, config, created_at from public.ai_providers
                       where workspace_id=$1 order by created_at desc`, [req.auth!.workspaceId]);
    return { providers: r.rows };
  });

  app.post("/ai/v1/providers", async (req, reply) => {
    if (!requireService(req, reply)) return;
    const body = z.object({
      slug: z.string().regex(/^[a-z0-9-]+$/),
      driver: z.enum(ALLOWED_DRIVERS as unknown as [AiDriver, ...AiDriver[]]),
      default_chat_model: z.string().optional(),
      default_embed_model: z.string().optional(),
      enabled: z.boolean().default(true),
      config: z.record(z.unknown()).default({}),
    }).parse(req.body);
    if (!ALLOWED_DRIVERS.includes(body.driver))
      return reply.code(400).send({ error: "driver_not_allowed", allowed: ALLOWED_DRIVERS });
    const r = await q<{ id: string }>(
      `insert into public.ai_providers (workspace_id, slug, driver, default_chat_model,
        default_embed_model, enabled, config)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [req.auth!.workspaceId, body.slug, body.driver, body.default_chat_model ?? null,
       body.default_embed_model ?? null, body.enabled, JSON.stringify(body.config)]);
    return { id: r.rows[0]!.id, ...body };
  });

  app.patch("/ai/v1/providers/:id", async (req, reply) => {
    if (!requireService(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = z.object({
      default_chat_model: z.string().nullable().optional(),
      default_embed_model: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
      config: z.record(z.unknown()).optional(),
    }).parse(req.body);
    const r = await q(`update public.ai_providers
      set default_chat_model=coalesce($1,default_chat_model),
          default_embed_model=coalesce($2,default_embed_model),
          enabled=coalesce($3,enabled),
          config=coalesce($4,config),
          updated_at=now()
      where id=$5 and workspace_id=$6`,
      [body.default_chat_model ?? null, body.default_embed_model ?? null,
       body.enabled ?? null, body.config ? JSON.stringify(body.config) : null,
       id, req.auth!.workspaceId]);
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  app.delete("/ai/v1/providers/:id", async (req, reply) => {
    if (!requireService(req, reply)) return;
    const { id } = req.params as { id: string };
    const r = await q(`delete from public.ai_providers where id=$1 and workspace_id=$2`,
      [id, req.auth!.workspaceId]);
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  // ---- Embeddings ----
  app.post("/ai/v1/embeddings", async (req, reply) => {
    const body = z.object({
      input: z.union([z.string(), z.array(z.string())]),
      model: z.string().default("google/gemini-embedding-001"),
      provider: z.string().optional(),
    }).parse(req.body);
    const { slug, driver } = await resolveDriver(req, body.provider).catch((e: Error) =>
      ({ slug: "invalid", driver: "lovable" as AiDriver, err: e }));
    const ep = driverEndpoints(driver);
    if (!ep.key) return reply.code(400).send({ error: "provider_key_missing",
      driver, hint: driver === "openai" ? "set OPENAI_API_KEY" : "set LOVABLE_AI_KEY" });
    const started = Date.now();
    const r = await fetch(ep.base_url.replace(/\/$/, "") + ep.embed_path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(driver === "lovable"
          ? { "Lovable-API-Key": ep.key, "X-Lovable-AIG-SDK": "pluto-baas" }
          : { authorization: `Bearer ${ep.key}` }),
      },
      body: JSON.stringify({ model: body.model, input: body.input }),
    });
    const j = await r.json() as { data?: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number };
      error?: { message?: string } };
    const latency = Date.now() - started;
    if (!r.ok || !j.data) {
      await record(req, { provider_slug: slug, model: body.model, endpoint: "embeddings",
        latency_ms: latency, status_code: r.status, error: j.error?.message ?? `HTTP ${r.status}` });
      return reply.code(r.status).send({ error: "provider_error", detail: j });
    }
    await record(req, { provider_slug: slug, model: body.model, endpoint: "embeddings",
      tokens_in: j.usage?.prompt_tokens ?? 0, latency_ms: latency, status_code: 200 });
    return { embeddings: j.data.map((d) => d.embedding), model: body.model,
             usage: { tokens_in: j.usage?.prompt_tokens ?? 0, tokens_out: 0 } };
  });

  // ---- Chat completions ----
  app.post("/ai/v1/chat/completions", async (req, reply) => {
    const body = z.object({
      messages: z.array(z.object({ role: z.enum(["system","user","assistant"]), content: z.string() })).min(1),
      model: z.string().default("google/gemini-3-flash-preview"),
      provider: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().positive().max(8192).optional(),
    }).parse(req.body);
    const { slug, driver } = await resolveDriver(req, body.provider);
    const ep = driverEndpoints(driver);
    if (!ep.key) return reply.code(400).send({ error: "provider_key_missing", driver });
    const started = Date.now();
    const r = await fetch(ep.base_url.replace(/\/$/, "") + ep.chat_path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(driver === "lovable"
          ? { "Lovable-API-Key": ep.key, "X-Lovable-AIG-SDK": "pluto-baas" }
          : { authorization: `Bearer ${ep.key}` }),
      },
      body: JSON.stringify({
        model: body.model, messages: body.messages,
        ...(body.temperature != null ? { temperature: body.temperature } : {}),
        ...(body.max_tokens != null ? { max_tokens: body.max_tokens } : {}),
      }),
    });
    const j = await r.json() as { choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string } };
    const latency = Date.now() - started;
    await record(req, { provider_slug: slug, model: body.model, endpoint: "chat",
      tokens_in: j.usage?.prompt_tokens ?? 0, tokens_out: j.usage?.completion_tokens ?? 0,
      latency_ms: latency, status_code: r.status,
      error: r.ok ? null : (j.error?.message ?? `HTTP ${r.status}`) });
    if (!r.ok) return reply.code(r.status).send({ error: "provider_error", detail: j });
    return {
      content: j.choices?.[0]?.message?.content ?? "",
      model: body.model,
      usage: j.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
    };
  });

  // ---- Vector search ----
  app.post("/ai/v1/vector/:collection/search", async (req, reply) => {
    const { collection } = req.params as { collection: string };
    if (!readAllow().includes(collection))
      return reply.code(400).send({ error: "collection_not_allowed", allowed: readAllow() });
    const body = z.object({
      vector: z.array(z.number()).optional(),
      query: z.string().optional(),
      k: z.number().int().positive().max(100).default(10),
      distance: z.enum(["cosine","l2","ip"]).default("cosine"),
    }).parse(req.body);

    let vec = body.vector;
    if (!vec) {
      if (!body.query) return reply.code(400).send({ error: "vector_or_query_required" });
      // Embed the query first — recursive call to /embeddings would need re-auth, so inline.
      const ep = driverEndpoints("lovable");
      if (!ep.key) return reply.code(400).send({ error: "no_provider_for_embedding" });
      const r = await fetch(ep.base_url.replace(/\/$/,"") + "/embeddings", {
        method: "POST",
        headers: { "content-type":"application/json", "Lovable-API-Key": ep.key, "X-Lovable-AIG-SDK":"pluto-baas" },
        body: JSON.stringify({ model: "google/gemini-embedding-001", input: body.query }),
      });
      const j = await r.json() as { data?: Array<{ embedding: number[] }> };
      vec = j.data?.[0]?.embedding;
      if (!vec) return reply.code(502).send({ error: "embed_failed" });
    }
    const op = body.distance === "cosine" ? "<=>" : body.distance === "l2" ? "<->" : "<#>";
    // NOTE: collection name is allow-list validated above → safe to interpolate.
    const started = Date.now();
    const r = await q<{ id: string; content: string; metadata: Record<string, unknown>; distance: number }>(
      `select id, content, metadata, embedding ${op} $1::vector as distance
       from public.${collection} where workspace_id=$2
       order by embedding ${op} $1::vector limit $3`,
      [`[${vec.join(",")}]`, req.auth!.workspaceId, body.k]);
    await record(req, { provider_slug: "internal", model: "pgvector", endpoint: "vector.search",
      latency_ms: Date.now() - started, status_code: 200 });
    return { hits: r.rows };
  });

  // ---- Usage ----
  app.get("/ai/v1/usage", async (req) => {
    const qs = req.query as { limit?: string; endpoint?: string };
    const limit = Math.min(Number(qs.limit ?? 100), 500);
    const r = await q(`select id, provider_slug, model, endpoint, tokens_in, tokens_out,
                       latency_ms, status_code, cost_usd_micro, created_at, actor_id
                       from public.ai_usage where workspace_id=$1
                       ${qs.endpoint ? "and endpoint=$2" : ""}
                       order by created_at desc limit ${qs.endpoint ? "$3" : "$2"}`,
      qs.endpoint ? [req.auth!.workspaceId, qs.endpoint, limit] : [req.auth!.workspaceId, limit]);
    return { rows: r.rows, total: r.rowCount };
  });
};

export default aiPlugin;
