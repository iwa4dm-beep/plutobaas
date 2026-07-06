import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Config } from '../config.js';

/**
 * Registers OpenAPI 3.0 spec generation + Swagger UI.
 *
 * - JSON spec:  GET /openapi.json
 * - HTML docs:  GET /docs
 *
 * Fastify's swagger plugin auto-discovers every route with a `schema`
 * property; routes without one still appear (path + method) but with no
 * request/response detail. Groups routes by URL prefix into tags.
 */
export async function swaggerPlugin(app: FastifyInstance, cfg: Config) {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Pluto BaaS API',
        description:
          'Self-hosted Backend-as-a-Service. Auth, Postgres REST, Storage, ' +
          'Realtime, Functions, Jobs, and more.',
        version: '0.1.0',
        contact: { name: 'Pluto', url: 'https://api.timescard.cloud' },
        license: { name: 'MIT' },
      },
      servers: [
        { url: `http://${cfg.HOST === '0.0.0.0' ? 'localhost' : cfg.HOST}:${cfg.PORT}`, description: 'Local' },
        { url: 'https://api.timescard.cloud', description: 'Production' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'apikey' },
        },
      },
      tags: [
        { name: 'health', description: 'Liveness & readiness probes' },
        { name: 'auth', description: 'Sign-up / sign-in / tokens' },
        { name: 'rest', description: 'Postgres REST (PostgREST-compatible)' },
        { name: 'storage', description: 'S3-backed object storage' },
        { name: 'realtime', description: 'WebSocket + broadcast channels' },
        { name: 'functions', description: 'Edge / serverless functions' },
        { name: 'jobs', description: 'Background jobs & workflows' },
        { name: 'admin', description: 'Admin surface (service-role only)' },
      ],
    },
    // Auto-tag routes by first path segment (e.g. /auth/v1/... → "auth")
    transform: ({ schema, url }) => {
      const seg = url.split('/').filter(Boolean)[0] ?? 'root';
      const tag =
        seg === 'livez' || seg === 'readyz' || seg === 'healthz' || seg === 'health'
          ? 'health'
          : seg;
      const s = (schema ?? {}) as Record<string, unknown>;
      if (!s.tags) s.tags = [tag];
      return { schema: s as any, url };
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
  });

  // Convenience alias — raw spec at /openapi.json (swagger-ui exposes /docs/json too)
  app.get('/openapi.json', async () => app.swagger());
}
