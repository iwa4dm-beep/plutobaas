/**
 * Centralized error mapping, friendly messages, structured logging tags, and
 * a lightweight in-memory "recurring failure" alert sink.
 *
 * Design goals:
 *   - Every error response has: { error, message, code, statusCode, traceId, fields? }
 *   - Zod validation errors → 400 with per-field friendly messages
 *   - Postgres error codes → sensible HTTP status + friendly message
 *   - Structured logs carry: traceId, tag, severity, code, stack (for 5xx)
 *   - Repeated 5xx / auth failures fire a throttled `alert=true` log line so
 *     an external log sink (docker logs → journald → alertmanager) can pick
 *     it up without extra infra.
 */
import { ZodError, type ZodIssue } from 'zod';

export type ApiErrorShape = {
  error: string;
  message: string;
  code?: string;
  hint?: string;
  detail?: string;
  statusCode: number;
  traceId?: string;
  /** Field-level errors for validation failures (Zod). */
  fields?: Record<string, string>;
};

const PG_STATUS_MAP: Record<string, { status: number; friendly: string }> = {
  '23505': { status: 409, friendly: 'That value already exists — please choose another.' },
  '23503': { status: 409, friendly: 'This action references data that no longer exists.' },
  '23502': { status: 400, friendly: 'A required field is missing.' },
  '23514': { status: 400, friendly: 'One of the values does not satisfy a required constraint.' },
  '42501': { status: 403, friendly: 'You do not have permission to perform this action.' },
  '42P01': { status: 500, friendly: 'A required table is missing — please contact support.' },
  '42703': { status: 500, friendly: 'A required column is missing — please contact support.' },
  '28P01': { status: 401, friendly: 'Authentication failed.' },
  '3D000': { status: 500, friendly: 'The requested database is unavailable.' },
  '40001': { status: 409, friendly: 'The change conflicted with another update — please retry.' },
  '57014': { status: 504, friendly: 'The operation took too long and was cancelled.' },
};

const FRIENDLY_BY_STATUS: Record<number, string> = {
  400: 'The request was invalid.',
  401: 'Please sign in to continue.',
  403: 'You do not have permission to perform this action.',
  404: 'We could not find what you were looking for.',
  409: 'That action conflicts with the current state.',
  413: 'The upload is too large.',
  415: 'That file type is not supported.',
  422: 'The submitted data was not accepted.',
  429: 'Too many requests — please slow down and try again.',
  500: 'Something went wrong on our side. Please try again.',
  502: 'An upstream service is temporarily unavailable.',
  503: 'The service is temporarily unavailable.',
  504: 'The request timed out.',
};

function fieldPath(issue: ZodIssue): string {
  return issue.path.length ? issue.path.map(String).join('.') : '_root';
}

/** Convert a ZodError into `{ fields: { path: msg }, message: firstMsg }`. */
export function formatZodError(err: ZodError): { message: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = fieldPath(issue);
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = err.issues[0];
  const message = first
    ? first.path.length
      ? `${fieldPath(first)}: ${first.message}`
      : first.message
    : 'Validation failed';
  return { message, fields };
}

/**
 * Normalize any thrown value into an { status, body } pair for the Fastify
 * error handler. Also returns a `tag` for structured logging.
 */
export function mapError(
  err: unknown,
  ctx: { traceId?: string } = {},
): { status: number; body: ApiErrorShape; tag: string; severity: 'warn' | 'error' } {
  // Zod validation
  if (err instanceof ZodError) {
    const { message, fields } = formatZodError(err);
    return {
      status: 400,
      severity: 'warn',
      tag: 'validation',
      body: {
        error: 'ValidationError',
        message,
        code: 'validation_failed',
        statusCode: 400,
        traceId: ctx.traceId,
        fields,
      },
    };
  }

  const e = err as {
    statusCode?: number;
    name?: string;
    message?: string;
    code?: string;
    hint?: string;
    detail?: string;
    validation?: unknown;
  };

  // Fastify built-in schema validation
  if (Array.isArray(e?.validation)) {
    const fields: Record<string, string> = {};
    for (const v of e.validation as Array<{ instancePath?: string; message?: string; params?: any }>) {
      const key = (v.instancePath || '').replace(/^\//, '').replaceAll('/', '.') || '_root';
      if (!fields[key]) fields[key] = v.message || 'invalid value';
    }
    return {
      status: 400,
      severity: 'warn',
      tag: 'validation',
      body: {
        error: 'ValidationError',
        message: e.message || 'The request was invalid.',
        code: 'validation_failed',
        statusCode: 400,
        traceId: ctx.traceId,
        fields,
      },
    };
  }

  // Postgres code → HTTP status
  if (typeof e?.code === 'string' && PG_STATUS_MAP[e.code]) {
    const m = PG_STATUS_MAP[e.code];
    return {
      status: m.status,
      severity: m.status >= 500 ? 'error' : 'warn',
      tag: `pg.${e.code}`,
      body: {
        error: e.name || 'DatabaseError',
        message: m.friendly,
        code: e.code,
        hint: e.hint,
        detail: e.detail,
        statusCode: m.status,
        traceId: ctx.traceId,
      },
    };
  }

  const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
  const friendly =
    status >= 500
      ? FRIENDLY_BY_STATUS[500]
      : e?.message && e.message.length < 500
        ? e.message
        : FRIENDLY_BY_STATUS[status] || FRIENDLY_BY_STATUS[500];

  return {
    status,
    severity: status >= 500 ? 'error' : 'warn',
    tag: status >= 500 ? 'internal' : 'client',
    body: {
      error: e?.name || (status >= 500 ? 'InternalError' : 'RequestError'),
      message: friendly,
      code: e?.code,
      hint: e?.hint,
      detail: e?.detail,
      statusCode: status,
      traceId: ctx.traceId,
    },
  };
}

// ---------------------------------------------------------------------------
// Recurring-failure alert sink
// ---------------------------------------------------------------------------
type Bucket = { count: number; firstAt: number; lastAlertAt: number };
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 5 * 60_000;   // 5 min rolling window
const THRESHOLD = 10;           // 10+ occurrences of same tag
const ALERT_COOLDOWN_MS = 15 * 60_000;

/**
 * Record a failure signal. Returns a payload to log as `alert=true` when the
 * same tag crosses THRESHOLD within WINDOW_MS (with a cooldown).
 */
export function recordFailure(tag: string): null | { tag: string; count: number; windowMs: number } {
  const now = Date.now();
  const b = buckets.get(tag);
  if (!b || now - b.firstAt > WINDOW_MS) {
    buckets.set(tag, { count: 1, firstAt: now, lastAlertAt: b?.lastAlertAt || 0 });
    return null;
  }
  b.count += 1;
  if (b.count >= THRESHOLD && now - b.lastAlertAt > ALERT_COOLDOWN_MS) {
    b.lastAlertAt = now;
    return { tag, count: b.count, windowMs: WINDOW_MS };
  }
  return null;
}
