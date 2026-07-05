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

  // CORS
  const origins = cfg.CORS_ORIGINS === '*' ? true : cfg.CORS_ORIGINS.split(',').map((s) => s.trim());
  await app.register(cors, {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-client-info', 'prefer', 'range'],
    exposedHeaders: ['content-range', 'x-total-count'],
  });

  // Rate limit
  await app.register(rateLimit, {
    max: cfg.RATE_LIMIT_GLOBAL,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/livez' || req.url === '/readyz' || req.url === '/healthz',
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

  // Routes
  await healthRoutes(app, cfg);
  await authRoutes(app, cfg);
  await restRoutes(app, cfg);
  await storageRoutes(app, cfg);
  await realtimeRoutes(app, cfg);


  // Root
  app.get('/', async () => ({
    service: 'pluto-api',
    version: '0.1.0',
    docs: 'https://github.com/your-org/pluto-backend',
    endpoints: ['/livez', '/readyz', '/healthz', '/auth/v1/health'],
  }));

  // Global error handler — always JSON
  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const status = err.statusCode || 500;
    reply.code(status).send({
      error: err.name || 'Error',
      message: err.message,
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
