/**
 * In-memory error-event ring buffer keyed by traceId.
 *
 * Populated from `setErrorHandler` in server.ts. Read by
 * `GET /admin/v1/traces/:traceId` (support/incident triage) — see
 * `routes/observability.ts`.
 *
 * Design:
 *   - Bounded size (default 2000) — worst-case memory ~2 MB.
 *   - Newest-wins Map ordering; oldest evicted when full.
 *   - PII-conscious: request bodies / responses are NOT stored here.
 *     Only the shape needed for triage: url, method, status, error class,
 *     code, tag, severity, fields, hint, actorId, at, stack (5xx only).
 *   - `record()` never throws — a bug in observability MUST NOT take down
 *     the error handler that called it.
 */

export type ErrorEvent = {
  traceId: string;
  at: string;                 // ISO timestamp
  method: string;
  url: string;
  status: number;
  error: string;              // e.g. 'ValidationError'
  message: string;            // friendly text
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

const CAPACITY = 2000;
const store = new Map<string, ErrorEvent>();

export function recordErrorEvent(evt: ErrorEvent): void {
  try {
    // Ensure newest-wins ordering: delete then set moves the key to the tail.
    if (store.has(evt.traceId)) store.delete(evt.traceId);
    store.set(evt.traceId, evt);
    // Evict oldest until we're at capacity.
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
  // Iterate newest-first by walking backwards; Map preserves insertion order.
  const arr = Array.from(store.values());
  for (let i = arr.length - 1; i >= 0 && out.length < limit; i--) out.push(arr[i]);
  return out;
}

/** Test-only. */
export function _resetErrorEventsForTests(): void {
  store.clear();
}
