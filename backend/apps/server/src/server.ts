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

  app.get("/healthz", async () => ({ ok: true, service: "pluto", version: "0.3.0" }));

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
