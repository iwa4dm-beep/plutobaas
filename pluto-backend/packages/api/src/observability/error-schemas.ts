/**
 * Reusable OpenAPI 3.0 components for the standardized Pluto error envelope
 * plus a minimal Zod → OpenAPI JSON Schema converter so route handlers can
 * document validation with the SAME schemas they use in `parseBody / parseQuery
 * / parseParams`.
 *
 * Usage in a route:
 *
 *   import { zodToOpenApi, standardErrorResponses } from '../observability/error-schemas.js';
 *
 *   const CreateProject = z.object({ name: z.string().min(1).max(64) });
 *
 *   app.post('/projects', {
 *     schema: {
 *       body: zodToOpenApi(CreateProject),
 *       response: { ...standardErrorResponses() },
 *     },
 *   }, async (req) => {
 *     const data = parseBody(CreateProject, req.body); // same schema
 *     ...
 *   });
 */
import type { ZodTypeAny, ZodRawShape } from 'zod';
import { z } from 'zod';

// -- Standard envelope schema (OpenAPI/JSON-Schema) -------------------------

export const ApiErrorSchema = {
  type: 'object',
  required: ['error', 'message', 'statusCode'],
  properties: {
    error: { type: 'string', example: 'ValidationError', description: 'Machine-readable error class.' },
    message: { type: 'string', example: 'name: String must contain at least 1 character(s)', description: 'Friendly, user-safe summary.' },
    code: { type: 'string', nullable: true, example: 'validation_failed', description: 'Stable machine code (Postgres SQLSTATE for DB errors).' },
    hint: { type: 'string', nullable: true, description: 'Optional operator hint.' },
    detail: { type: 'string', nullable: true, description: 'Optional low-level detail (safe to display).' },
    statusCode: { type: 'integer', example: 400 },
    traceId: { type: 'string', nullable: true, example: 'cli_9f8e...4c', description: 'Correlation ID — echoed on x-request-id / x-correlation-id.' },
    fields: {
      type: 'object',
      nullable: true,
      additionalProperties: { type: 'string' },
      description: 'Field-level validation messages, keyed by dotted path.',
      example: { name: 'String must contain at least 1 character(s)', 'meta.slug': 'Invalid slug' },
    },
  },
} as const;

// -- Concrete example bodies (referenced by responses.examples) -------------

const VALIDATION_EXAMPLE = {
  error: 'ValidationError',
  message: 'name: String must contain at least 1 character(s)',
  code: 'validation_failed',
  statusCode: 400,
  traceId: 'cli_9f8e2d13-4c5b-4c6f-98a3-e2c1d0ab77f0',
  fields: { name: 'String must contain at least 1 character(s)' },
};

const UNAUTHORIZED_EXAMPLE = { error: 'UnauthorizedError', message: 'Please sign in to continue.', code: 'unauthorized', statusCode: 401, traceId: 'cli_...' };
const FORBIDDEN_EXAMPLE = { error: 'ForbiddenError', message: 'You do not have permission to perform this action.', code: '42501', statusCode: 403, traceId: 'cli_...' };
const NOT_FOUND_EXAMPLE = { error: 'NotFound', message: 'The requested endpoint does not exist.', code: 'route_not_found', statusCode: 404, traceId: 'cli_...' };
const CONFLICT_EXAMPLE = { error: 'DatabaseError', message: 'That value already exists — please choose another.', code: '23505', statusCode: 409, traceId: 'cli_...' };
const PAYLOAD_TOO_LARGE_EXAMPLE = {
  error: 'UploadError',
  message: 'The uploaded file is 42.10 MiB — the maximum is 20.0 MiB.',
  code: 'file_too_large',
  statusCode: 413,
  traceId: 'cli_...',
  fields: { file: 'The uploaded file is 42.10 MiB — the maximum is 20.0 MiB.' },
};
const UNSUPPORTED_MEDIA_EXAMPLE = {
  error: 'UploadError',
  message: 'Files of type "application/x-msdownload" are not accepted. Allowed: image/*, application/pdf.',
  code: 'unsupported_media_type',
  statusCode: 415,
  traceId: 'cli_...',
  fields: { file: 'Files of type "application/x-msdownload" are not accepted. Allowed: image/*, application/pdf.' },
};
const RATE_LIMIT_EXAMPLE = { error: 'RateLimitError', message: 'Too many requests — please slow down and try again.', code: 'rate_limited', statusCode: 429, traceId: 'cli_...' };
const INTERNAL_EXAMPLE = { error: 'InternalError', message: 'Something went wrong on our side. Please try again.', code: null, statusCode: 500, traceId: 'cli_...' };

/**
 * Standard set of response entries to spread into a route's Fastify
 * `schema.response` map. All reference the shared `ApiError` schema so
 * the docs page stays consistent.
 */
export function standardErrorResponses(opts: { include4xx?: boolean; include5xx?: boolean; includeUploads?: boolean } = {}) {
  const { include4xx = true, include5xx = true, includeUploads = false } = opts;
  const withEx = (example: unknown, description: string) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example } },
  });
  const out: Record<string, unknown> = {};
  if (include4xx) {
    out['400'] = withEx(VALIDATION_EXAMPLE, 'Validation failed — see `fields` for per-input messages.');
    out['401'] = withEx(UNAUTHORIZED_EXAMPLE, 'Missing or invalid credentials.');
    out['403'] = withEx(FORBIDDEN_EXAMPLE, 'Authenticated but not permitted (RLS or role check).');
    out['404'] = withEx(NOT_FOUND_EXAMPLE, 'Resource or route not found.');
    out['409'] = withEx(CONFLICT_EXAMPLE, 'Uniqueness / foreign-key conflict.');
    out['429'] = withEx(RATE_LIMIT_EXAMPLE, 'Rate limit exceeded.');
  }
  if (includeUploads) {
    out['413'] = withEx(PAYLOAD_TOO_LARGE_EXAMPLE, 'Uploaded file or body exceeds the size limit.');
    out['415'] = withEx(UNSUPPORTED_MEDIA_EXAMPLE, 'Uploaded file type is not accepted.');
  }
  if (include5xx) {
    out['500'] = withEx(INTERNAL_EXAMPLE, 'Unhandled server error. Grep server logs for `traceId`.');
  }
  return out;
}

// -- Minimal Zod → OpenAPI JSON Schema converter ---------------------------
//
// Covers the shapes actually used in Pluto route validators: object, string,
// number, boolean, integer, enum, literal, array, union, nullable, optional,
// default, and record. Unknown types degrade to `{}` (accept-any) instead of
// throwing so a stale schema never breaks the docs endpoint.

type JsonSchema = Record<string, unknown>;

export function zodToOpenApi(schema: ZodTypeAny): JsonSchema {
  const def: any = (schema as any)?._def;
  if (!def) return {};
  const t: string = def.typeName;

  switch (t) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const c of def.checks ?? []) {
        if (c.kind === 'min') out.minLength = c.value;
        else if (c.kind === 'max') out.maxLength = c.value;
        else if (c.kind === 'email') out.format = 'email';
        else if (c.kind === 'url') out.format = 'uri';
        else if (c.kind === 'uuid') out.format = 'uuid';
        else if (c.kind === 'regex') out.pattern = c.regex.source;
      }
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' };
      for (const c of def.checks ?? []) {
        if (c.kind === 'int') out.type = 'integer';
        else if (c.kind === 'min') out.minimum = c.value;
        else if (c.kind === 'max') out.maximum = c.value;
      }
      return out;
    }
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodDate': return { type: 'string', format: 'date-time' };
    case 'ZodLiteral': return { const: def.value };
    case 'ZodEnum': return { type: 'string', enum: def.values };
    case 'ZodNativeEnum': return { enum: Object.values(def.values as Record<string, unknown>) };
    case 'ZodArray': return { type: 'array', items: zodToOpenApi(def.type) };
    case 'ZodTuple': return { type: 'array', items: (def.items as ZodTypeAny[]).map(zodToOpenApi), minItems: def.items.length, maxItems: def.items.length };
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return { oneOf: (def.options as ZodTypeAny[]).map(zodToOpenApi) };
    case 'ZodIntersection':
      return { allOf: [zodToOpenApi(def.left), zodToOpenApi(def.right)] };
    case 'ZodNullable': {
      const inner = zodToOpenApi(def.innerType);
      return { ...inner, nullable: true };
    }
    case 'ZodOptional': return zodToOpenApi(def.innerType);
    case 'ZodDefault': return { ...zodToOpenApi(def.innerType), default: def.defaultValue?.() };
    case 'ZodEffects': return zodToOpenApi(def.schema);
    case 'ZodRecord': return { type: 'object', additionalProperties: zodToOpenApi(def.valueType) };
    case 'ZodAny':
    case 'ZodUnknown':
    case 'ZodVoid':
    case 'ZodNever':
      return {};
    case 'ZodObject': {
      const shape: ZodRawShape = def.shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const v = value as ZodTypeAny;
        properties[key] = zodToOpenApi(v);
        // required if not optional / not defaulted
        const inner: any = (v as any)._def;
        const isOptional = inner?.typeName === 'ZodOptional' || inner?.typeName === 'ZodDefault';
        if (!isOptional) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length) out.required = required;
      return out;
    }
    default: return {};
  }
}

/**
 * Sanity-check we didn't ship without `z` in the closure (tsgo tree-shakes
 * this out — kept purely to force the import to remain visible for
 * consumers copy-pasting from this module).
 */
export const _internal_zType = z;
