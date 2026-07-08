import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { loadConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { restRoutes } from './routes/rest.js';
import { storageRoutes } from './routes/storage.js';
import { realtimeRoutes } from './routes/realtime.js';
import { adminRoutes } from './routes/admin.js';
import { functionsRoutes } from './routes/functions.js';
import { auditRoutes } from './routes/audit.js';
import { schemaRoutes } from './routes/schema.js';
import { grantsRoutes } from './routes/grants.js';
import { migrationsRoutes } from './routes/migrations.js';
import { sqlRoutes } from './routes/sql.js';
import { backupsRoutes } from './routes/backups.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { searchRoutes } from './routes/search.js';
import { billingRoutes } from './routes/billing.js';
import { branchesRoutes } from './routes/branches.js';
import { graphqlRoutes } from './routes/graphql.js';
import { sdkRoutes } from './routes/sdk.js';
import { authAdvancedRoutes } from './routes/auth-advanced.js';
import { orgsRoutes } from './routes/orgs.js';
import { realtimePlusRoutes } from './routes/realtime-plus.js';
import { storagePlusRoutes } from './routes/storage-plus.js';
import { functionsPlusRoutes } from './routes/functions-plus.js';
import { queuesRoutes } from './routes/queues.js';
import { aiRoutes } from './routes/ai.js';
import { replicasRoutes } from './routes/replicas.js';
import { complianceRoutes } from './routes/compliance.js';
import { vaultRoutes } from './routes/vault.js';
import { studioRoutes } from './routes/studio.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { jobsRoutes } from './routes/jobs.js';
import { corsRoutes } from './routes/cors.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { invitesRoutes } from './routes/invites.js';
import { tokensRoutes } from './routes/tokens.js';
import { dbioRoutes } from './routes/dbio.js';
import { makeOriginCallback, primeCorsCache } from './cors/registry.js';
import { startEmailWorker } from './email/queue.js';


import { metricsPlugin } from './observability/metrics.js';
import { swaggerPlugin } from './observability/swagger.js';





async function main() {
  const cfg = loadConfig();

  const app = Fastify({
    logger: {
      level: cfg.LOG_LEVEL,
      transport: cfg.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
    },
    bodyLimit: cfg.BODY_LIMIT_MB * 1024 * 1024,
    trustProxy: true,
  });

  // Security
  await app.register(helmet, { contentSecurityPolicy: false });

  // CORS — database-driven allow-list (admin.cors_origins), refreshed every
  // 15s + on every mutation. CORS_ORIGINS env is merged in as a static
  // fallback so the API's own domain survives DB outages. localhost is
  // auto-allowed in NODE_ENV=development.
  await primeCorsCache(cfg).catch(() => undefined);
  await app.register(cors, {
    origin: makeOriginCallback(cfg),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-client-info', 'prefer', 'range'],
    exposedHeaders: ['content-range', 'x-total-count'],
    maxAge: 86400,
  });



  // Trace-ID: every request gets an `x-request-id` (accepted from the caller
  // when supplied, otherwise minted) so operators can grep one identifier
  // across API logs, upload failures, and RLS 4xx bodies. The ID is echoed
  // on every response and included in the JSON error envelope below.
  const genTraceId = () =>
    (globalThis.crypto?.randomUUID?.() ??
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-request-id'];
    const traceId = (typeof incoming === 'string' && incoming.length <= 128 && incoming) || genTraceId();
    (req as any).traceId = traceId;
    reply.header('x-request-id', traceId);
    (req as any).log = req.log.child({ traceId });
  });

  // Detailed request/response logging for the dashboard flows that operators
  // most often need to debug (workspace / project / API-key / token creation)
  // + storage uploads and REST/RLS failures. We capture the parsed body
  // pre-handler and re-emit it — along with the response payload, status,
  // and traceId — in an `onResponse` hook. Log line is structured (pino)
  // so `docker logs api | grep dashboardFlow` surfaces every 4xx/5xx with
  // full context.
  const LOGGED_PATH_RE = /^\/(admin\/v1\/(workspaces|projects)(\/|$)|tokens\/v1\/tokens(\/|$)|storage\/v1\/|rest\/v1\/)/;
  const shouldLog = (req: any, status: number) => LOGGED_PATH_RE.test(req.url) && (status >= 400 || /^\/(admin|tokens)\//.test(req.url));
  app.addHook('preHandler', async (req) => {
    if (LOGGED_PATH_RE.test(req.url)) (req as any)._loggedBody = req.body ?? null;
  });
  app.addHook('onSend', async (req, _reply, payload) => {
    if (LOGGED_PATH_RE.test(req.url) && typeof payload === 'string' && payload.length <= 4096) {
      (req as any)._loggedResponse = payload;
    }
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode;
    if (!shouldLog(req, status)) return;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    let response: unknown = (req as any)._loggedResponse ?? null;
    if (typeof response === 'string') { try { response = JSON.parse(response); } catch { /* keep as string */ } }
    app.log[level]({
      dashboardFlow: true,
      traceId: (req as any).traceId,
      method: req.method,
      url: req.url,
      status,
      durationMs: reply.elapsedTime,
      requestBody: (req as any)._loggedBody ?? null,
      response,
    }, `dashboardFlow ${req.method} ${req.url} → ${status}`);
  });


  // Rate limit
  await app.register(rateLimit, {
    max: cfg.RATE_LIMIT_GLOBAL,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/livez' || req.url === '/readyz' || req.url === '/healthz' || req.url === '/openapi.json' || req.url.startsWith('/docs'),
  });


  // JWT
  await app.register(jwt, {
    secret: cfg.PLUTO_JWT_SECRET,
    sign: { iss: cfg.JWT_ISSUER, expiresIn: cfg.JWT_ACCESS_TTL },
    verify: { allowedIss: cfg.JWT_ISSUER },
  });

  // Multipart (for storage uploads)
  await app.register(multipart, {
    limits: { fileSize: cfg.BODY_LIMIT_MB * 1024 * 1024, files: 1 },
  });

  // Metrics — register BEFORE routes so hooks capture everything
  await metricsPlugin(app);

  // OpenAPI / Swagger UI — must be registered BEFORE routes so it can
  // introspect every route added afterwards.
  await swaggerPlugin(app, cfg);

  // Routes
  await healthRoutes(app, cfg);
  await authRoutes(app, cfg);
  await restRoutes(app, cfg);
  await storageRoutes(app, cfg);
  await realtimeRoutes(app, cfg);
  await adminRoutes(app, cfg);
  await functionsRoutes(app, cfg);
  await auditRoutes(app, cfg);
  await schemaRoutes(app, cfg);
  await grantsRoutes(app, cfg);
  await migrationsRoutes(app, cfg);
  await sqlRoutes(app, cfg);
  await backupsRoutes(app, cfg);
  await webhooksRoutes(app, cfg);
  await searchRoutes(app, cfg);
  await billingRoutes(app, cfg);
  await branchesRoutes(app, cfg);
  await graphqlRoutes(app, cfg);
  await sdkRoutes(app, cfg);
  await authAdvancedRoutes(app, cfg);
  await orgsRoutes(app, cfg);
  await realtimePlusRoutes(app, cfg);
  await storagePlusRoutes(app, cfg);
  await functionsPlusRoutes(app, cfg);
  await queuesRoutes(app, cfg);
  await aiRoutes(app, cfg);
  await replicasRoutes(app, cfg);
  await complianceRoutes(app, cfg);
  await vaultRoutes(app, cfg);
  await studioRoutes(app, cfg);
  await marketplaceRoutes(app, cfg);
  await jobsRoutes(app, cfg);
  await corsRoutes(app, cfg);
  await onboardingRoutes(app, cfg);
  await invitesRoutes(app, cfg);
  await tokensRoutes(app, cfg);
  await dbioRoutes(app, cfg);






  // Root
  app.get('/', async () => ({
    service: 'pluto-api',
    version: '0.1.0',
    docs: 'https://github.com/your-org/pluto-backend',
    endpoints: ['/livez', '/readyz', '/healthz', '/health/deps', '/metrics', '/docs', '/openapi.json', '/auth/v1/*', '/rest/v1/*', '/storage/v1/*', '/realtime/v1/*', '/admin/v1/*', '/functions/v1/*', '/jobs/v1/*', '/tokens/v1/*'],
  }));

  // Global error handler — always JSON, always echoes traceId + x-request-id
  // so the client can display it and operators can grep the API log for
  // the same ID. Postgres RLS/permission errors are surfaced with their
  // native code + hint fields (e.g. `42501 new row violates row-level
  // security policy`) instead of a generic 500.
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; name?: string; message?: string; code?: string; hint?: string; detail?: string };
    const traceId = (req as any).traceId as string | undefined;
    // Map Postgres permission/RLS errors → 403
    let status = e.statusCode || 500;
    if (typeof e.code === 'string' && /^42501$/.test(e.code)) status = 403;
    app.log.error({ traceId, code: e.code, hint: e.hint, detail: e.detail }, e.message || 'error');
    if (traceId) reply.header('x-request-id', traceId);
    reply.code(status).send({
      error: e.name || 'Error',
      message: e.message || 'Internal Server Error',
      code: e.code,
      hint: e.hint,
      detail: e.detail,
      statusCode: status,
      traceId,
    });
  });


  // Boot-time schema check — hit /health/migrations/required internally so
  // missing Phase-17 tables surface in `docker logs` immediately, not only
  // when the dashboard tries to create a workspace/project/token.
  try {
    const probe = await app.inject({ method: 'GET', url: '/health/migrations/required' });
    if (probe.statusCode !== 200) {
      const body = probe.json() as { missing?: string[]; hint?: string };
      app.log.warn(
        { missing: body.missing, hint: body.hint },
        `⚠ required migrations not applied — dashboard project/workspace/token flows will fail. Set AUTO_MIGRATE=1 and restart.`,
      );
    } else {
      app.log.info('✓ required migrations verified (workspaces / projects / tokens schema present)');
    }
  } catch (e: any) {
    app.log.warn({ err: e?.message }, 'migrations preflight probe failed');
  }

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info(`🚀 Pluto API listening on http://${cfg.HOST}:${cfg.PORT}`);


  // Background email worker — polls admin.email_queue every 10s.
  startEmailWorker(cfg, {
    info: (m: string) => app.log.info(m),
    error: (m: string) => app.log.error(m),
  });

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
