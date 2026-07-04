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
import { commsPlugin } from "./modules/comms/plugin.js";
import { advancedAuthPlugin } from "./modules/advanced_auth/plugin.js";
import { templatesPlugin } from "./modules/templates/plugin.js";
import { aiPlugin } from "./modules/ai/plugin.js";
import { edgeRoutes } from "./modules/edge/routes.js";
import { migrationRoutes } from "./modules/admin/migrations.js";
import { jobsRoutes } from "./modules/jobs/routes.js";
import { workspacesRoutes } from "./modules/admin/workspaces.js";
import { sqlRunnerRoutes } from "./modules/admin/sql.js";
import { schemaRoutes } from "./modules/admin/schema.js";
import { env } from "./config.js";

async function main() {
  // Structured JSON logging — one line per request/error, easy to grep &
  // ship to Loki/CloudWatch. Request-id is auto-attached to every child
  // log so a single failing call can be traced end-to-end across DB,
  // storage, and edge-function hops. Secret headers are redacted.
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Pretty output in dev, raw JSON in prod/docker for log shippers.
      transport: process.env.NODE_ENV === "production" ? undefined : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.apikey",
          "req.headers['x-service-role-key']",
          "req.headers.cookie",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          remoteAddress: req.ip,
          workspace_id: (req.headers?.["x-workspace-id"] as string) ?? null,
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
    // Trust upstream proxy (Caddy) so req.ip is the real client, not 127.0.0.1.
    trustProxy: true,
    // Use inbound x-request-id when set, else generate — surfaced back to
    // the client so users can quote it in bug reports.
    genReqId: (req) => (req.headers["x-request-id"] as string) || `req_${Math.random().toString(36).slice(2, 12)}`,
    disableRequestLogging: false,
  });
  app.addHook("onSend", async (req, reply) => { reply.header("x-request-id", req.id); });

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
  await app.register(workspacesRoutes, { prefix: "/admin/v1/workspaces" });
  await app.register(sqlRunnerRoutes,  { prefix: "/admin/v1/sql" });
  await app.register(schemaRoutes,     { prefix: "/admin/v1/schema" });
  const { integrationsRoutes } = await import("./modules/admin/integrations.js");
  await app.register(integrationsRoutes, { prefix: "/admin/v1" });
  await app.register(jobsRoutes, { prefix: "/jobs/v1" });
  await app.register(realtimeRoutes, { prefix: "/realtime/v1" });
  await app.register(edgeRoutes, { prefix: "/functions/v1" });
  await app.register(commsPlugin);         // Phase 14 — /comms/v1/*, PLUTO_ENABLE_COMMS=1
  await app.register(advancedAuthPlugin);  // Phase 15 — /auth/v1/mfa|sso, /push/v1/*, PLUTO_ENABLE_ADVANCED_AUTH=1
  await app.register(templatesPlugin);     // Phase 15 — /templates/v1/*, PLUTO_ENABLE_TEMPLATES=1
  await app.register(aiPlugin);            // Phase 16 — /ai/v1/*, PLUTO_ENABLE_AI=1
  const { scalingPlugin, startQueueWorker } = await import("./modules/scaling/plugin.js");
  const { observabilityPlugin } = await import("./modules/observability/plugin.js");
  await app.register(scalingPlugin);        // Phase 17 — /queue/v1/*, /cache/v1/*, /admin/v1/rate-limits — PLUTO_ENABLE_SCALING=1
  await app.register(observabilityPlugin);  // Phase 18 — /obs/v1/*, /compliance/v1/* — PLUTO_ENABLE_OBSERVABILITY=1
  const { devexPlugin } = await import("./modules/devex/plugin.js");
  const { enterprisePlugin } = await import("./modules/enterprise/plugin.js");
  await app.register(devexPlugin);          // Phase 19 — /devex/v1/* — PLUTO_ENABLE_DEVEX=1
  await app.register(enterprisePlugin);     // Phase 20 — /enterprise/v1/* — PLUTO_ENABLE_ENTERPRISE=1
  const { branchingPlugin, usagePlugin } = await import("./modules/branching/plugin.js");
  await app.register(branchingPlugin);      // Phase 21 — /branches/v1/*, /schema/v1/* — PLUTO_ENABLE_BRANCHING=1
  await app.register(usagePlugin);          // Phase 21 — /usage/v1/*                   — PLUTO_ENABLE_USAGE=1
  const { realtimeV2Plugin } = await import("./modules/realtime_v2/plugin.js");
  const { vectorPlugin } = await import("./modules/vector/plugin.js");
  await app.register(realtimeV2Plugin);     // Phase 23 — /rt2/v1/*   — PLUTO_ENABLE_REALTIME_V2=1
  await app.register(vectorPlugin);         // Phase 23 — /vec/v1/*   — PLUTO_ENABLE_VECTOR=1
  const { edgeV2Plugin } = await import("./modules/edge_v2/plugin.js");
  const { backupsPlugin } = await import("./modules/backups/plugin.js");
  await app.register(edgeV2Plugin);         // Phase 24 — /fn/v2/*    — PLUTO_ENABLE_EDGE_V2=1
  await app.register(backupsPlugin);        // Phase 24 — /backups/v1 — PLUTO_ENABLE_BACKUPS=1
  const { logsPlugin, startLogRetentionSweeper } = await import("./modules/logs/plugin.js");
  const { tokensPlugin } = await import("./modules/tokens/plugin.js");
  const { authCompletionPlugin } = await import("./modules/auth_completion/plugin.js");
  const { storageExtPlugin } = await import("./modules/storage_ext/plugin.js");
  await app.register(logsPlugin);           // Phase 27 — /logs/v1/*
  await app.register(tokensPlugin);         // Phase 28 — /tokens/v1/*
  await app.register(authCompletionPlugin); // Phase 31 — /auth/v1/recover, /confirm-email, /otp/*
  await app.register(storageExtPlugin);     // Phase 32 — /storage/v1/render/*, /storage/v1/upload/resumable
  startLogRetentionSweeper(app.log);

  // Top-level Prometheus scrape target — proxies to the observability
  // module when enabled so scrapers hit a stable /metrics regardless of
  // module wiring. Returns 404 when observability is disabled.
  app.get("/metrics", async (_req, reply) => {
    if (process.env.PLUTO_ENABLE_OBSERVABILITY !== "1") {
      reply.code(404); return { error: "observability_disabled" };
    }
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return app.inject({ method: "GET", url: "/obs/v1/metrics" }).then((r) => r.body);
  });

  // Durable in-process worker. Handlers can be registered via
  // registerQueueHandler(); default `pluto.test` handler is included.
  if (process.env.PLUTO_QUEUE_WORKER === "1" && process.env.PLUTO_ENABLE_SCALING === "1") {
    startQueueWorker(app.log);
  }

  await app.listen({ host: "0.0.0.0", port: env.PORT });
  app.log.info(`Pluto API listening on :${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
