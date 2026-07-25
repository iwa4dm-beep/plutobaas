/**
 * Error-event capture: in-memory ring buffer + durable DB persistence.
 *
 * The in-memory buffer keeps the hot path free of DB latency and lets
 * `/admin/v1/traces/:traceId` answer instantly for recent events. Every
 * capture is ALSO fire-and-forget persisted to `admin.error_events`
 * (migration 0040) so trace history survives restarts and supports
 * long-term audit.
 *
 * Read path used by routes/observability.ts:
 *   1. Try the in-memory buffer (fastest, covers ~2000 most recent).
 *   2. Fall back to `admin.error_events` via `lookupErrorEventDb`.
 *   3. `queryErrorEvents` always hits the DB — that's the pagination/filter
 *      surface for the trace-viewer UI.
 *
 * Persistence never throws: a bug here MUST NOT take down the central
 * error handler that called us.
 */

import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';

export type ErrorEvent = {
  traceId: string;
  at: string;                 // ISO timestamp
  method: string;
  url: string;
  endpoint?: string | null;   // normalized route pattern (from Fastify routerPath)
  status: number;
  error: string;
  message: string;
  code?: string;
  tag: string;
  severity: 'warn' | 'error';
  fields?: Record<string, string>;
  hint?: string;
  detail?: string;
  actorId?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  stack?: string;             // 5xx only
};

// ---------------------------------------------------------------------------
// In-memory ring buffer
// ---------------------------------------------------------------------------

const CAPACITY = 2000;
const store = new Map<string, ErrorEvent>();

export function recordErrorEvent(evt: ErrorEvent): void {
  try {
    if (store.has(evt.traceId)) store.delete(evt.traceId);
    store.set(evt.traceId, evt);
    while (store.size > CAPACITY) {
      const oldest = store.keys().next().value as string | undefined;
      if (!oldest) break;
      store.delete(oldest);
    }
  } catch {
    /* observability must never crash the caller */
  }
}

export function lookupErrorEvent(traceId: string): ErrorEvent | undefined {
  return store.get(traceId);
}

export function listRecentErrors(limit = 50): ErrorEvent[] {
  const out: ErrorEvent[] = [];
  const arr = Array.from(store.values());
  for (let i = arr.length - 1; i >= 0 && out.length < limit; i--) out.push(arr[i]);
  return out;
}

/** Test-only. */
export function _resetErrorEventsForTests(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// Durable persistence (admin.error_events)
// ---------------------------------------------------------------------------

let pruneCounter = 0;
const PRUNE_EVERY = 500;   // opportunistic vacuum every N inserts

/**
 * Fire-and-forget insert into admin.error_events. Never throws — logs
 * silently on failure so the error handler stays reliable.
 */
export function persistErrorEvent(cfg: Config, evt: ErrorEvent): void {
  // Async but not awaited by the caller. Wrap in setImmediate so the reply
  // isn't blocked on DB round-trip.
  setImmediate(() => {
    void (async () => {
      try {
        const sql = getSql(cfg);
        await sql`
          INSERT INTO admin.error_events (
            trace_id, at, method, url, endpoint, status, error, message, code,
            tag, severity, fields, hint, detail, actor_id, user_agent, ip, stack
          ) VALUES (
            ${evt.traceId},
            ${evt.at},
            ${evt.method},
            ${evt.url},
            ${evt.endpoint ?? null},
            ${evt.status},
            ${evt.error},
            ${evt.message},
            ${evt.code ?? null},
            ${evt.tag},
            ${evt.severity},
            ${evt.fields ? JSON.stringify(evt.fields) : null}::jsonb,
            ${evt.hint ?? null},
            ${evt.detail ?? null},
            ${evt.actorId ?? null},
            ${evt.userAgent ?? null},
            ${evt.ip ?? null},
            ${evt.stack ?? null}
          )
          ON CONFLICT (trace_id) DO NOTHING
        `;
        pruneCounter = (pruneCounter + 1) % PRUNE_EVERY;
        if (pruneCounter === 0) {
          await sql`SELECT admin.prune_error_events()`;
        }
      } catch (err) {
        // Table may not exist yet (migration 0040 not applied); stay quiet
        // after the first warning per process to avoid log spam.
        // eslint-disable-next-line no-console
        if (!(persistErrorEvent as any)._warned) {
          (persistErrorEvent as any)._warned = true;
          // eslint-disable-next-line no-console
          console.warn('[error-log] persistErrorEvent failed (buffer still active):', (err as Error)?.message);
        }
      }
    })();
  });
}

export async function lookupErrorEventDb(cfg: Config, traceId: string): Promise<ErrorEvent | undefined> {
  try {
    const sql = getSql(cfg);
    const rows = await sql<any[]>`
      SELECT trace_id, at, method, url, endpoint, status, error, message, code,
             tag, severity, fields, hint, detail, actor_id, user_agent, ip, stack
        FROM admin.error_events
       WHERE trace_id = ${traceId}
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return undefined;
    return rowToEvent(r);
  } catch {
    return undefined;
  }
}

export type QueryFilters = {
  status?: number;
  minStatus?: number;
  maxStatus?: number;
  errorCode?: string;
  tag?: string;
  endpoint?: string;         // substring match on endpoint OR url
  method?: string;
  from?: string;             // ISO
  to?: string;               // ISO
  actorId?: string;
  limit: number;
  cursor?: string;           // ISO — return rows strictly older than this
};

export async function queryErrorEvents(
  cfg: Config,
  f: QueryFilters,
): Promise<{ events: ErrorEvent[]; nextCursor: string | null }> {
  const sql = getSql(cfg);
  // Build clauses via tagged-template composition; every value is
  // parameterized so this stays SQL-injection safe.
  const clauses: any[] = [];
  if (f.status != null) clauses.push(sql`status = ${f.status}`);
  if (f.minStatus != null) clauses.push(sql`status >= ${f.minStatus}`);
  if (f.maxStatus != null) clauses.push(sql`status <= ${f.maxStatus}`);
  if (f.errorCode) clauses.push(sql`code = ${f.errorCode}`);
  if (f.tag) clauses.push(sql`tag = ${f.tag}`);
  if (f.method) clauses.push(sql`method = ${f.method}`);
  if (f.actorId) clauses.push(sql`actor_id = ${f.actorId}`);
  if (f.endpoint) {
    const pat = `%${f.endpoint}%`;
    clauses.push(sql`(endpoint ILIKE ${pat} OR url ILIKE ${pat})`);
  }
  if (f.from) clauses.push(sql`at >= ${f.from}`);
  if (f.to) clauses.push(sql`at <= ${f.to}`);
  if (f.cursor) clauses.push(sql`at < ${f.cursor}`);

  // Reduce to a single AND-joined fragment or empty.
  let where: any = sql``;
  if (clauses.length) {
    where = sql`WHERE ${clauses[0]}`;
    for (let i = 1; i < clauses.length; i++) where = sql`${where} AND ${clauses[i]}`;
  }

  const limit = Math.max(1, Math.min(200, f.limit));
  try {
    const rows = await sql<any[]>`
      SELECT trace_id, at, method, url, endpoint, status, error, message, code,
             tag, severity, fields, hint, detail, actor_id, user_agent, ip, stack
        FROM admin.error_events
        ${where}
        ORDER BY at DESC
        LIMIT ${limit + 1}
    `;
    const events = rows.slice(0, limit).map(rowToEvent);
    const nextCursor = rows.length > limit ? events[events.length - 1]!.at : null;
    return { events, nextCursor };
  } catch {
    // DB unavailable — fall back to in-memory buffer with best-effort filtering.
    const mem = listRecentErrors(2000).filter((e) => matchesInMemory(e, f)).slice(0, limit);
    return { events: mem, nextCursor: null };
  }
}

function matchesInMemory(e: ErrorEvent, f: QueryFilters): boolean {
  if (f.status != null && e.status !== f.status) return false;
  if (f.minStatus != null && e.status < f.minStatus) return false;
  if (f.maxStatus != null && e.status > f.maxStatus) return false;
  if (f.errorCode && e.code !== f.errorCode) return false;
  if (f.tag && e.tag !== f.tag) return false;
  if (f.method && e.method !== f.method) return false;
  if (f.actorId && e.actorId !== f.actorId) return false;
  if (f.endpoint) {
    const needle = f.endpoint.toLowerCase();
    if (!(e.endpoint ?? '').toLowerCase().includes(needle) &&
        !e.url.toLowerCase().includes(needle)) return false;
  }
  if (f.from && e.at < f.from) return false;
  if (f.to && e.at > f.to) return false;
  if (f.cursor && e.at >= f.cursor) return false;
  return true;
}

function rowToEvent(r: any): ErrorEvent {
  return {
    traceId: r.trace_id,
    at: typeof r.at === 'string' ? r.at : new Date(r.at).toISOString(),
    method: r.method,
    url: r.url,
    endpoint: r.endpoint ?? undefined,
    status: r.status,
    error: r.error,
    message: r.message,
    code: r.code ?? undefined,
    tag: r.tag,
    severity: r.severity,
    fields: r.fields ?? undefined,
    hint: r.hint ?? undefined,
    detail: r.detail ?? undefined,
    actorId: r.actor_id ?? null,
    userAgent: r.user_agent ?? null,
    ip: r.ip ?? null,
    stack: r.stack ?? undefined,
  };
}
