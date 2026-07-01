import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { authRoutes } from "./modules/auth/routes.js";
import { oauthRoutes } from "./modules/auth/oauth.js";
import { restRoutes } from "./modules/rest/routes.js";
import { storageRoutes } from "./modules/storage/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { realtimeRoutes } from "./modules/realtime/routes.js";
import { edgeRoutes } from "./modules/edge/routes.js";
import { migrationRoutes } from "./modules/admin/migrations.js";
import { jobsRoutes } from "./modules/jobs/routes.js";
import { env } from "./config.js";

async function main() {
  const app = Fastify({ logger: { level: "info" } });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(websocket);

  const startedAt = Date.now();
  app.get("/healthz", async () => ({ ok: true, service: "pluto", version: "0.3.0" }));
  app.get("/readyz", async (_req, reply) => {
    const checks: Record<string, { ok: boolean; error?: string; latency_ms?: number }> = {};
    const t0 = Date.now();
    try {
      const { sql } = await import("kysely");
      const { db } = await import("./db/index.js");
      await sql`select 1`.execute(db);
      checks.db = { ok: true, latency_ms: Date.now() - t0 };
    } catch (e) {
      checks.db = { ok: false, error: (e as Error).message, latency_ms: Date.now() - t0 };
    }
    try {
      const { storage } = await import("./lib/storage.js");
      checks.storage = { ok: !!storage };
    } catch (e) {
      checks.storage = { ok: false, error: (e as Error).message };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    reply.code(ok ? 200 : 503);
    return { ok, uptime_s: Math.floor((Date.now() - startedAt) / 1000), checks };
  });

  await app.register(authRoutes, { prefix: "/auth/v1" });
  await app.register(oauthRoutes, { prefix: "/auth/v1" });
  await app.register(restRoutes, { prefix: "/rest/v1" });
  await app.register(storageRoutes, { prefix: "/storage/v1" });
  await app.register(adminRoutes, { prefix: "/admin/v1" });
  await app.register(migrationRoutes, { prefix: "/admin/v1/migrations" });
  await app.register(jobsRoutes, { prefix: "/jobs/v1" });
  await app.register(realtimeRoutes, { prefix: "/realtime/v1" });
  await app.register(edgeRoutes, { prefix: "/functions/v1" });

  await app.listen({ host: "0.0.0.0", port: env.PORT });
  app.log.info(`Pluto API listening on :${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
