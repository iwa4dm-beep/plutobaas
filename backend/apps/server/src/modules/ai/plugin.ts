/**
 * Fastify plugin — AI & Vector (Phase 16.0 skeleton).
 *
 * Enable with `PLUTO_ENABLE_AI=1`. When the Lovable AI Gateway key is
 * present (`LOVABLE_AI_KEY`) the module will proxy embeddings + chat calls
 * once the 16.1 handlers land; today it advertises the surface so the SDK
 * generator, dashboard playground, and integration tests all have a
 * stable target.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { DEFAULT_VECTOR_ALLOW } from "./types.js";

const notImpl = (feature: string, phase = "16.1") => ({
  error: "not_implemented",
  feature,
  phase,
  message: `${feature} lands in Phase ${phase}. See docs/PHASE-16.md.`,
});

function readAllow(): string[] {
  const raw = process.env.PLUTO_AI_VECTOR_ALLOW;
  if (!raw) return [...DEFAULT_VECTOR_ALLOW];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export const aiPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_AI !== "1") {
    app.log.info({ module: "ai" }, "ai disabled (set PLUTO_ENABLE_AI=1 to enable)");
    return;
  }
  const gatewayReady = !!process.env.LOVABLE_AI_KEY || !!process.env.OPENAI_API_KEY;
  app.log.info({ module: "ai", phase: "16.0", gatewayReady }, "ai registered (skeleton)");

  // Discovery — real routes, safe metadata. Lets the dashboard render even
  // before the 16.1 handlers land.
  app.get("/ai/v1/status", async () => ({
    module: "ai",
    phase: "16.0",
    gateway_ready: gatewayReady,
    vector_allow: readAllow(),
    drivers: ["lovable", "openai", "voyage", "cohere", "anthropic"],
  }));

  // Provider config (CRUD lands in 16.1)
  app.get   ("/ai/v1/providers",                 async (_r, reply) => reply.code(501).send(notImpl("ai.providers.list")));
  app.post  ("/ai/v1/providers",                 async (_r, reply) => reply.code(501).send(notImpl("ai.providers.create")));
  app.patch ("/ai/v1/providers/:id",             async (_r, reply) => reply.code(501).send(notImpl("ai.providers.update")));
  app.delete("/ai/v1/providers/:id",             async (_r, reply) => reply.code(501).send(notImpl("ai.providers.delete")));

  // Inference proxies
  app.post  ("/ai/v1/embeddings",                async (_r, reply) => reply.code(501).send(notImpl("ai.embeddings")));
  app.post  ("/ai/v1/chat/completions",          async (_r, reply) => reply.code(501).send(notImpl("ai.chat", "16.3")));

  // Vector search — collection must be in PLUTO_AI_VECTOR_ALLOW.
  app.post  ("/ai/v1/vector/:collection/search", async (req, reply) => {
    const { collection } = req.params as { collection: string };
    if (!readAllow().includes(collection)) {
      return reply.code(400).send({
        error: "collection_not_allowed",
        message: `Collection '${collection}' is not in PLUTO_AI_VECTOR_ALLOW.`,
        allowed: readAllow(),
      });
    }
    return reply.code(501).send(notImpl("ai.vector.search", "16.2"));
  });

  // Usage ledger (read-only)
  app.get   ("/ai/v1/usage",                     async (_r, reply) => reply.code(501).send(notImpl("ai.usage", "16.1")));
};

export default aiPlugin;
