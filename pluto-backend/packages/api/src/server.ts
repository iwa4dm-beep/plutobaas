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





  // Root
  app.get('/', async () => ({
    service: 'pluto-api',
    version: '0.1.0',
    docs: 'https://github.com/your-org/pluto-backend',
    endpoints: ['/livez', '/readyz', '/healthz', '/health/deps', '/metrics', '/docs', '/openapi.json', '/auth/v1/*', '/rest/v1/*', '/storage/v1/*', '/realtime/v1/*', '/admin/v1/*', '/functions/v1/*', '/jobs/v1/*'],
  }));

  // Global error handler — always JSON
  app.setErrorHandler((err, _req, reply) => {
    const error = err as { statusCode?: number; name?: string; message?: string };
    app.log.error(err);
    const status = error.statusCode || 500;
    reply.code(status).send({
      error: error.name || 'Error',
      message: error.message || 'Internal Server Error',
      statusCode: status,
    });
  });

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info(`🚀 Pluto API listening on http://${cfg.HOST}:${cfg.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
