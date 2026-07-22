import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { authRoutes } from "./modules/auth/routes.js";
import { oauthRoutes } from "./modules/auth/oauth.js";
import { restRoutes } from "./modules/rest/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { commsPlugin } from "./modules/comms/plugin.js";
import { advancedAuthPlugin } from "./modules/advanced_auth/plugin.js";
import { templatesPlugin } from "./modules/templates/plugin.js";
import { aiPlugin } from "./modules/ai/plugin.js";
import { migrationRoutes } from "./modules/admin/migrations.js";
import { workspacesRoutes } from "./modules/admin/workspaces.js";
import { sqlRunnerRoutes } from "./modules/admin/sql.js";
import { schemaRoutes } from "./modules/admin/schema.js";
import { env } from "./config.js";
import { corsAdminPlugin } from "./modules/cors/plugin.js";
import { isOriginAllowed, refreshAllowedOrigins } from "./modules/cors/registry.js";

// Legacy modules archived under ./modules/_archive/. To re-enable during the
// v4/v5 migration window, set PLUTO_ENABLE_LEGACY=1. Wave 2 consolidation:
// canonical versions are auth+auth_v4, storage_v4, realtime_v5, edge_v7,
// data_api_v4, vector_v3, observability_v3, jobs_v2. Migrations untouched.
const ENABLE_LEGACY = process.env.PLUTO_ENABLE_LEGACY === "1";


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

  // Dynamic CORS — consults public.allowed_origins (per-workspace whitelist).
  // Requests with no Origin header (server-to-server, curl) always pass.
  // In dev (NODE_ENV !== production) we also allow localhost:* as a fallback
  // so a fresh install with an empty allow-list is still usable.
  await refreshAllowedOrigins();
  const devFallback = process.env.NODE_ENV !== "production";
  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (devFallback && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
        return cb(null, true);
      }
      isOriginAllowed(origin)
        .then((ok) => cb(null, ok))
        .catch(() => cb(null, false));
    },
  });
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
  await app.register(adminRoutes, { prefix: "/admin/v1" });
  await app.register(migrationRoutes, { prefix: "/admin/v1/migrations" });
  await app.register(workspacesRoutes, { prefix: "/admin/v1/workspaces" });
  await app.register(sqlRunnerRoutes,  { prefix: "/admin/v1/sql" });
  await app.register(schemaRoutes,     { prefix: "/admin/v1/schema" });
  await app.register(corsAdminPlugin);
  const { integrationsRoutes } = await import("./modules/admin/integrations.js");
  await app.register(integrationsRoutes, { prefix: "/admin/v1" });
  await app.register(commsPlugin);         // Phase 14 — /comms/v1/*, PLUTO_ENABLE_COMMS=1
  await app.register(advancedAuthPlugin);  // Phase 15 — /auth/v1/mfa|sso, /push/v1/*, PLUTO_ENABLE_ADVANCED_AUTH=1
  await app.register(templatesPlugin);     // Phase 15 — /templates/v1/*, PLUTO_ENABLE_TEMPLATES=1
  await app.register(aiPlugin);            // Phase 16 — /ai/v1/*, PLUTO_ENABLE_AI=1
  const { scalingPlugin, startQueueWorker } = await import("./modules/scaling/plugin.js");
  const { observabilityPlugin } = await import("./modules/observability/plugin.js");
  await app.register(scalingPlugin);        // Phase 17 — /queue/v1/*, /cache/v1/*, /admin/v1/rate-limits — PLUTO_ENABLE_SCALING=1
  await app.register(observabilityPlugin);  // Phase 18 — base /obs/v1/* — required by top-level /metrics proxy
  const { devexPlugin } = await import("./modules/devex/plugin.js");
  const { enterprisePlugin } = await import("./modules/enterprise/plugin.js");
  await app.register(devexPlugin);
  await app.register(enterprisePlugin);
  const { branchingPlugin, usagePlugin } = await import("./modules/branching/plugin.js");
  await app.register(branchingPlugin);
  await app.register(usagePlugin);
  const { backupsPlugin } = await import("./modules/backups/plugin.js");
  await app.register(backupsPlugin);
  const { logsPlugin, startLogRetentionSweeper } = await import("./modules/logs/plugin.js");
  const { tokensPlugin } = await import("./modules/tokens/plugin.js");
  const { storageExtPlugin } = await import("./modules/storage_ext/plugin.js");
  const { cdcPlugin } = await import("./modules/cdc/plugin.js");
  const { billingPlugin } = await import("./modules/billing/plugin.js");
  const { pitrPlugin } = await import("./modules/pitr/plugin.js");
  const { compliancePlugin } = await import("./modules/compliance/plugin.js");
  await app.register(logsPlugin);
  await app.register(tokensPlugin);
  await app.register(storageExtPlugin);
  await app.register(cdcPlugin);
  await app.register(billingPlugin);
  await app.register(pitrPlugin);
  await app.register(compliancePlugin);
  const { broadcastV2Plugin } = await import("./modules/broadcast_v2/plugin.js");
  await app.register(broadcastV2Plugin);
  // Canonical (Wave 2) — one plugin per domain.
  const { storageV4Plugin } = await import("./modules/storage_v4/plugin.js");
  await app.register(storageV4Plugin);      // Canonical Storage
  const { edgeV7Plugin } = await import("./modules/edge_v7/plugin.js");
  await app.register(edgeV7Plugin);         // Canonical Edge Functions
  const { authV4Plugin } = await import("./modules/auth_v4/plugin.js");
  await app.register(authV4Plugin);         // Canonical Auth addon (SAML SSO / SCIM)
  const { observabilityV3Plugin } = await import("./modules/observability_v3/plugin.js");
  await app.register(observabilityV3Plugin); // Canonical Observability
  const { dataApiV4Plugin } = await import("./modules/data_api_v4/plugin.js");
  await app.register(dataApiV4Plugin);      // Canonical Data API
  const { realtimeV5Plugin } = await import("./modules/realtime_v5/plugin.js");
  await app.register(realtimeV5Plugin);     // Canonical Realtime
  const { vectorV3Plugin } = await import("./modules/vector_v3/plugin.js");
  await app.register(vectorV3Plugin);       // Canonical Vector
  const { jobsV2Plugin } = await import("./modules/jobs_v2/plugin.js");
  await app.register(jobsV2Plugin);         // Canonical Jobs

  // Legacy modules — archived under modules/_archive/. Loaded only when
  // PLUTO_ENABLE_LEGACY=1 to help clients migrate to canonical versions.
  if (ENABLE_LEGACY) {
    const legacy = await Promise.all([
      import("./modules/_archive/storage/routes.js"),
      import("./modules/_archive/realtime/routes.js"),
      import("./modules/_archive/edge/routes.js"),
      import("./modules/_archive/jobs/routes.js"),
      import("./modules/_archive/auth_completion/plugin.js"),
      import("./modules/_archive/auth_phase41/plugin.js"),
      import("./modules/_archive/auth_v3/plugin.js"),
      import("./modules/_archive/storage_v2/plugin.js"),
      import("./modules/_archive/storage_v3/plugin.js"),
      import("./modules/_archive/realtime_v2/plugin.js"),
      import("./modules/_archive/realtime_v3/plugin.js"),
      import("./modules/_archive/realtime_v4/plugin.js"),
      import("./modules/_archive/edge_v2/plugin.js"),
      import("./modules/_archive/edge_v3/plugin.js"),
      import("./modules/_archive/edge_v4/plugin.js"),
      import("./modules/_archive/edge_v5/plugin.js"),
      import("./modules/_archive/edge_v6/plugin.js"),
      import("./modules/_archive/data_api/plugin.js"),
      import("./modules/_archive/data_api_v2/plugin.js"),
      import("./modules/_archive/data_api_v3/plugin.js"),
      import("./modules/_archive/vector/plugin.js"),
      import("./modules/_archive/vector_v2/plugin.js"),
      import("./modules/_archive/observability_v2/plugin.js"),
    ]);
    const [
      st, rt, ed, jb,
      authComp, authP41, authV3,
      sv2, sv3, rv2, rv3, rv4,
      ev2, ev3, ev4, ev5, ev6,
      da1, da2, da3, vec1, vec2, ov2,
    ] = legacy;
    await app.register(st.storageRoutes, { prefix: "/storage/v1" });
    await app.register(rt.realtimeRoutes);
    await app.register(ed.edgeRoutes, { prefix: "/functions/v1" });
    await app.register(jb.jobsRoutes, { prefix: "/jobs/v1" });
    await app.register(authComp.authCompletionPlugin);
    await app.register(authP41.authPhase41Plugin);
    await app.register(authV3.authV3Plugin);
    await app.register(sv2.storageV2Plugin);
    await app.register(sv3.storageV3Plugin);
    await app.register(rv2.realtimeV2Plugin);
    await app.register(rv3.realtimeV3Plugin);
    await app.register(rv4.realtimeV4Plugin);
    await app.register(ev2.edgeV2Plugin);
    await app.register(ev3.edgeV3Plugin);
    await app.register(ev4.edgeV4Plugin);
    await app.register(ev5.edgeV5Plugin);
    await app.register(ev6.edgeV6Plugin);
    await app.register(da1.dataApiPlugin);
    await app.register(da2.dataApiV2Plugin);
    await app.register(da3.dataApiV3Plugin);
    await app.register(vec1.vectorPlugin);
    await app.register(vec2.vectorV2Plugin);
    await app.register(ov2.observabilityV2Plugin);
    app.log.warn("PLUTO_ENABLE_LEGACY=1 — 23 archived modules re-mounted");
  }

  startLogRetentionSweeper();







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
