/**
 * Integration tests for the centralized error handler.
 *
 * Runs a stripped-down Fastify app that mirrors the production wiring:
 *   - onRequest hook that mints/echoes traceId (x-request-id)
 *   - setErrorHandler → mapError → standard envelope
 *   - setNotFoundHandler → same envelope
 *   - error-event ring buffer captured for /admin/v1/traces lookup
 *
 * We deliberately don't spin up @pluto/api's `main()` — Postgres, JWT
 * secrets, and dozens of route modules are irrelevant to what we're
 * testing. This test IS the contract for the envelope + trace flow.
 *
 * Run:
 *   node --test --import tsx pluto-backend/packages/api/tests/error-handler.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { mapError } from '../src/observability/errors.js';
import {
  recordErrorEvent,
  lookupErrorEvent,
  listRecentErrors,
  _resetErrorEventsForTests,
} from '../src/observability/error-log.js';
import { parseBody } from '../src/util/validate.js';
import { UploadError, validateUpload } from '../src/util/multipart.js';

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Same onRequest hook shape as src/server.ts.
  app.addHook('onRequest', async (req, reply) => {
    const h = req.headers;
    const incoming = h['x-request-id'] ?? h['x-correlation-id'] ?? h['x-trace-id'];
    const raw = Array.isArray(incoming) ? incoming[0] : incoming;
    const traceId =
      (typeof raw === 'string' && raw.length > 0 && raw.length <= 128 && raw) ||
      `test_${Math.random().toString(36).slice(2, 12)}`;
    (req as any).traceId = traceId;
    reply.header('x-request-id', traceId);
    reply.header('x-correlation-id', traceId);
  });

  app.setNotFoundHandler((req, reply) => {
    const traceId = (req as any).traceId as string | undefined;
    reply.code(404).send({
      error: 'NotFound',
      message: 'The requested endpoint does not exist.',
      code: 'route_not_found',
      statusCode: 404,
      traceId,
    });
  });

  app.setErrorHandler((err, req, reply) => {
    const traceId = (req as any).traceId as string | undefined;
    const { status, body, tag, severity } = mapError(err, { traceId });
    if (traceId) {
      recordErrorEvent({
        traceId,
        at: new Date().toISOString(),
        method: req.method,
        url: req.url,
        status,
        error: body.error,
        message: body.message,
        code: body.code,
        tag,
        severity,
        fields: body.fields,
        hint: body.hint,
        detail: body.detail,
        stack: status >= 500 && err instanceof Error ? err.stack : undefined,
      });
    }
    reply.code(status).send(body);
  });

  // -- Test-only routes ----------------------------------------------------

  const BodySchema = z.object({
    name: z.string().min(1).max(64),
    age: z.number().int().min(0),
    email: z.string().email().optional(),
  });

  app.post('/echo', async (req) => {
    const data = parseBody(BodySchema, req.body);
    return { ok: true, data };
  });

  // Fastify JSON-schema route → exercises the `validation` branch of mapError
  app.post('/fastify-schema', {
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
  }, async () => ({ ok: true }));

  app.get('/boom', async () => {
    throw new Error('kaboom');
  });

  app.get('/pg-conflict', async () => {
    const err: any = new Error('duplicate');
    err.code = '23505';
    err.name = 'PostgresError';
    err.detail = 'Key (email)=(a@b) already exists.';
    throw err;
  });

  app.get('/forbidden', async () => {
    const err: any = new Error('nope');
    err.statusCode = 403;
    err.code = '42501';
    throw err;
  });

  app.post('/upload/manual', async () => {
    // Simulate a handler that runs validateUpload().
    validateUpload({ size: 20 * 1024 * 1024, maxBytes: 5 * 1024 * 1024, filename: 'big.bin', contentType: 'application/pdf' });
    return { ok: true };
  });

  app.post('/upload/bad-mime', async () => {
    validateUpload({ size: 10, maxBytes: 1024, filename: 'x.exe', contentType: 'application/x-msdownload', allowedMime: ['image/*', 'application/pdf'] });
    return { ok: true };
  });

  app.post('/upload/fastify', async () => {
    // Simulate what @fastify/multipart throws under the hood.
    const err: any = new Error('request file too large');
    err.code = 'FST_REQ_FILE_TOO_LARGE';
    err.statusCode = 413;
    throw err;
  });

  return app;
}

// ---------------------------------------------------------------------------

describe('centralized error handler', () => {
  beforeEach(() => _resetErrorEventsForTests());

  it('maps ZodError to a 400 with per-field messages and validation_failed code', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'x-request-id': 'trace-zod-1', 'content-type': 'application/json' },
      payload: JSON.stringify({ name: '', age: -1, email: 'not-an-email' }),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as any;
    assert.equal(body.error, 'ValidationError');
    assert.equal(body.code, 'validation_failed');
    assert.equal(body.statusCode, 400);
    assert.equal(body.traceId, 'trace-zod-1');
    assert.ok(body.fields, 'fields present');
    assert.match(body.fields.name, /at least 1/i);
    assert.ok(body.fields.age, 'age field error');
    assert.ok(body.fields.email, 'email field error');
    // Response header echoes trace id.
    assert.equal(res.headers['x-request-id'], 'trace-zod-1');
    assert.equal(res.headers['x-correlation-id'], 'trace-zod-1');
    await app.close();
  });

  it('mints a traceId when the caller omits one and echoes it on the response + body', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as any;
    const headerTrace = res.headers['x-request-id'];
    assert.ok(typeof headerTrace === 'string' && headerTrace.length > 0);
    assert.equal(body.traceId, headerTrace);
    await app.close();
  });

  it('maps Fastify JSON-schema validation to the same envelope', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/fastify-schema',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as any;
    assert.equal(body.error, 'ValidationError');
    assert.equal(body.code, 'validation_failed');
    assert.ok(body.fields && Object.keys(body.fields).length > 0, 'fields populated');
    await app.close();
  });

  it('returns a 500 envelope with InternalError and hides the raw thrown message', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/boom',
      headers: { 'x-request-id': 'trace-500' },
    });
    assert.equal(res.statusCode, 500);
    const body = res.json() as any;
    assert.equal(body.error, 'InternalError');
    assert.equal(body.statusCode, 500);
    assert.equal(body.traceId, 'trace-500');
    // Must NOT leak the raw "kaboom" message.
    assert.doesNotMatch(body.message, /kaboom/);
    await app.close();
  });

  it('maps Postgres SQLSTATE 23505 to a 409 conflict envelope', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/pg-conflict', headers: { 'x-request-id': 't-conflict' } });
    assert.equal(res.statusCode, 409);
    const body = res.json() as any;
    assert.equal(body.code, '23505');
    assert.equal(body.statusCode, 409);
    assert.match(body.message, /already exists/i);
    assert.equal(body.traceId, 't-conflict');
    await app.close();
  });

  it('maps SQLSTATE 42501 → 403 forbidden', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/forbidden' });
    assert.equal(res.statusCode, 403);
    const body = res.json() as any;
    assert.equal(body.statusCode, 403);
    assert.equal(body.code, '42501');
    await app.close();
  });

  it('setNotFoundHandler returns the standardized envelope', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/does-not-exist', headers: { 'x-request-id': 't-404' } });
    assert.equal(res.statusCode, 404);
    const body = res.json() as any;
    assert.equal(body.error, 'NotFound');
    assert.equal(body.code, 'route_not_found');
    assert.equal(body.statusCode, 404);
    assert.equal(body.traceId, 't-404');
    await app.close();
  });

  it('captures the error event into the ring buffer and lookupErrorEvent returns it', async () => {
    const app = buildApp();
    await app.inject({ method: 'GET', url: '/boom', headers: { 'x-request-id': 'trace-buf-1' } });
    const evt = lookupErrorEvent('trace-buf-1');
    assert.ok(evt, 'event captured');
    assert.equal(evt!.status, 500);
    assert.equal(evt!.error, 'InternalError');
    assert.equal(evt!.url, '/boom');
    assert.equal(evt!.method, 'GET');
    assert.ok(evt!.stack, 'stack captured on 5xx');

    // 4xx should also be captured but without stack.
    await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'x-request-id': 'trace-buf-2', 'content-type': 'application/json' },
      payload: '{}',
    });
    const v = lookupErrorEvent('trace-buf-2');
    assert.ok(v);
    assert.equal(v!.status, 400);
    assert.equal(v!.stack, undefined);
    assert.deepEqual(Object.keys(v!.fields ?? {}).sort(), ['age', 'name'].sort());

    const recent = listRecentErrors(10);
    assert.ok(recent.length >= 2);
    // Newest first.
    assert.equal(recent[0].traceId, 'trace-buf-2');
    await app.close();
  });
});

// ---------------------------------------------------------------------------

describe('upload / multipart error mapping', () => {
  beforeEach(() => _resetErrorEventsForTests());

  it('validateUpload → 413 file_too_large envelope with fields.file', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/upload/manual', headers: { 'x-request-id': 'upl-413' } });
    assert.equal(res.statusCode, 413);
    const body = res.json() as any;
    assert.equal(body.error, 'UploadError');
    assert.equal(body.code, 'file_too_large');
    assert.equal(body.statusCode, 413);
    assert.ok(body.fields?.file, 'field-level upload error');
    assert.match(body.fields.file, /larger than/i);
    assert.equal(body.traceId, 'upl-413');
    await app.close();
  });

  it('validateUpload → 415 unsupported_media_type envelope', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/upload/bad-mime' });
    assert.equal(res.statusCode, 415);
    const body = res.json() as any;
    assert.equal(body.code, 'unsupported_media_type');
    assert.match(body.fields.file, /not accepted/i);
    await app.close();
  });

  it('Fastify FST_REQ_FILE_TOO_LARGE → 413 with the standard envelope', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/upload/fastify' });
    assert.equal(res.statusCode, 413);
    const body = res.json() as any;
    assert.equal(body.error, 'UploadError');
    assert.equal(body.code, 'file_too_large');
    assert.equal(body.statusCode, 413);
    await app.close();
  });
});

// ---------------------------------------------------------------------------

describe('mapError (pure function)', () => {
  it('preserves traceId for every branch', () => {
    const zod = z.object({ n: z.number() }).safeParse({ n: 'x' });
    assert.ok(!zod.success);
    const a = mapError(zod.error, { traceId: 'T1' });
    assert.equal(a.body.traceId, 'T1');

    const b = mapError(new UploadError('empty_file'), { traceId: 'T2' });
    assert.equal(b.body.traceId, 'T2');
    assert.equal(b.status, 400);

    const c = mapError({ statusCode: 401, message: 'no' }, { traceId: 'T3' });
    assert.equal(c.body.traceId, 'T3');
    assert.equal(c.status, 401);
  });

  it('never leaks a raw 5xx thrown message', () => {
    const r = mapError(new Error('SELECT *; DROP TABLE users'));
    assert.doesNotMatch(r.body.message, /DROP TABLE/);
    assert.equal(r.status, 500);
  });

  it('formats ZodError issues with dotted paths', () => {
    const schema = z.object({ user: z.object({ email: z.string().email() }) });
    const r = schema.safeParse({ user: { email: 'not-email' } });
    assert.ok(!r.success);
    const mapped = mapError(r.error);
    assert.ok(mapped.body.fields?.['user.email']);
  });
});
