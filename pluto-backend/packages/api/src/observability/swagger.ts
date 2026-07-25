import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Config } from '../config.js';
import { ApiErrorSchema } from './error-schemas.js';

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
          'Realtime, Functions, Jobs, and more.\n\n' +
          '## Error envelope\n\n' +
          'All errors share a single shape (see `components.schemas.ApiError`):\n\n' +
          '```json\n' +
          '{\n' +
          '  "error": "ValidationError",\n' +
          '  "message": "name: Required",\n' +
          '  "code": "validation_failed",\n' +
          '  "statusCode": 400,\n' +
          '  "traceId": "cli_9f8e...",\n' +
          '  "fields": { "name": "Required" }\n' +
          '}\n' +
          '```\n\n' +
          'Every response echoes the correlation ID on `x-request-id` and `x-correlation-id`. ' +
          'See `docs/api-errors.md` for the full contract.',
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
        // Shared error envelope — referenced by every route's default responses.
        schemas: {
          ApiError: ApiErrorSchema as any,
        },
        parameters: {
          RequestId: {
            name: 'x-request-id',
            in: 'header',
            required: false,
            description: 'Optional caller-supplied correlation ID. If omitted, the server mints one. Echoed on the response.',
            schema: { type: 'string', maxLength: 128, example: 'cli_9f8e2d13-4c5b-4c6f-98a3-e2c1d0ab77f0' },
          },
        },
        responses: {
          BadRequest: { description: 'Validation failed — see `fields` for per-input messages.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'ValidationError', message: 'name: Required', code: 'validation_failed', statusCode: 400, traceId: 'cli_...', fields: { name: 'Required' } } } } },
          Unauthorized: { description: 'Missing or invalid credentials.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'UnauthorizedError', message: 'Please sign in to continue.', statusCode: 401, traceId: 'cli_...' } } } },
          Forbidden: { description: 'Authenticated but not permitted.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'ForbiddenError', message: 'You do not have permission to perform this action.', code: '42501', statusCode: 403, traceId: 'cli_...' } } } },
          NotFound: { description: 'Resource or route not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'NotFound', message: 'The requested endpoint does not exist.', statusCode: 404, traceId: 'cli_...' } } } },
          Conflict: { description: 'Uniqueness / foreign-key conflict.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'DatabaseError', message: 'That value already exists — please choose another.', code: '23505', statusCode: 409, traceId: 'cli_...' } } } },
          PayloadTooLarge: { description: 'Uploaded file or body exceeds the size limit.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'UploadError', message: 'The uploaded file is 42.10 MiB — the maximum is 20.0 MiB.', code: 'file_too_large', statusCode: 413, traceId: 'cli_...', fields: { file: 'The uploaded file is 42.10 MiB — the maximum is 20.0 MiB.' } } } } },
          UnsupportedMediaType: { description: 'Uploaded file type is not accepted.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'UploadError', message: 'Files of type "application/x-msdownload" are not accepted.', code: 'unsupported_media_type', statusCode: 415, traceId: 'cli_...', fields: { file: 'Files of type "application/x-msdownload" are not accepted.' } } } } },
          TooManyRequests: { description: 'Rate limit exceeded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'RateLimitError', message: 'Too many requests — please slow down and try again.', statusCode: 429, traceId: 'cli_...' } } } },
          InternalError: { description: 'Unhandled server error. Grep server logs for `traceId`.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { error: 'InternalError', message: 'Something went wrong on our side. Please try again.', statusCode: 500, traceId: 'cli_...' } } } },
        },
        headers: {
          XRequestId: {
            description: 'Correlation ID for this response (matches `body.traceId`).',
            schema: { type: 'string' },
          },
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
    // Auto-tag routes by first path segment (e.g. /auth/v1/... → "auth") AND
    // auto-inject the standardized error responses + `x-request-id` request
    // parameter so every operation in the spec documents the same envelope.
    transform: ({ schema, url }) => {
      const seg = url.split('/').filter(Boolean)[0] ?? 'root';
      const tag =
        seg === 'livez' || seg === 'readyz' || seg === 'healthz' || seg === 'health'
          ? 'health'
          : seg;
      const s = (schema ?? {}) as Record<string, unknown>;
      if (!s.tags) s.tags = [tag];

      // Default error responses — merge, don't overwrite route-specific ones.
      const existing = (s.response as Record<string, unknown> | undefined) ?? {};
      const defaults: Record<string, unknown> = {
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
        409: { $ref: '#/components/responses/Conflict' },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/InternalError' },
      };
      s.response = { ...defaults, ...existing };

      // Correlation-ID parameter — appended once per route.
      const params = Array.isArray(s.parameters) ? [...(s.parameters as unknown[])] : [];
      if (!params.some((p) => (p as { name?: string })?.name === 'x-request-id')) {
        params.push({ $ref: '#/components/parameters/RequestId' });
      }
      s.parameters = params;

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
