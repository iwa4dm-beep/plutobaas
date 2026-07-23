/**
 * Shared helpers for detecting/handling `PlutoAuthError_401` (Session expired)
 * across route error boundaries, middleware, and UI banners.
 *
 * A single source of truth prevents blank screens when an admin server-fn
 * throws 401 — every route boundary redirects to `/auth` with a return path
 * and a friendly reason.
 */

export type AuthFailure = {
  status: number;
  code?: string;
  message?: string;
  hint?: string;
};

/**
 * Parse HTTP status out of an error thrown by admin middleware or `api()`.
 * Recognises:
 *   - `PlutoAuthError_401` name from `admin-middleware.ts`
 *   - JSON `{ status }` embedded in `error.message` (TanStack RPC boundary)
 *   - `ApiError.status`
 */
export function parseAuthFailure(err: unknown): AuthFailure | null {
  if (!(err instanceof Error)) return null;
  // ApiError from live.ts
  const anyErr = err as { name?: string; status?: unknown; body?: unknown; message?: string };
  if (typeof anyErr.status === "number") {
    const b = (anyErr.body ?? {}) as { error?: string; hint?: string };
    return { status: anyErr.status, code: b?.error, message: err.message, hint: b?.hint };
  }
  const m = /^PlutoAuthError_(\d+)$/.exec(err.name ?? "");
  if (m) {
    try {
      const p = JSON.parse(err.message) as { error?: string; message?: string; hint?: string };
      return { status: Number(m[1]), code: p?.error, message: p?.message ?? err.message, hint: p?.hint };
    } catch {
      return { status: Number(m[1]), message: err.message };
    }
  }
  try {
    const p = JSON.parse(err.message ?? "") as { status?: number; error?: string; message?: string; hint?: string };
    if (p && typeof p.status === "number") {
      return { status: p.status, code: p.error, message: p.message, hint: p.hint };
    }
  } catch { /* not JSON */ }
  return null;
}

export function isSessionExpired(err: unknown): boolean {
  const f = parseAuthFailure(err);
  return !!f && f.status === 401;
}

/**
 * Structured console warning for 401s — includes route, userId, timestamp
 * so the developer console shows exactly which route and which user hit
 * the expired session. Redacts tokens.
 */
export function logAuthFailure(source: string, err: unknown, ctx: {
  route?: string;
  userId?: string | null;
  requestId?: string;
} = {}): void {
  const f = parseAuthFailure(err) ?? { status: 0, message: err instanceof Error ? err.message : String(err) };
  // eslint-disable-next-line no-console
  console.warn("[pluto-auth]", source, {
    at: new Date().toISOString(),
    status: f.status,
    code: f.code,
    route: ctx.route ?? (typeof window !== "undefined" ? window.location.pathname : undefined),
    userId: ctx.userId ?? null,
    requestId: ctx.requestId,
    message: f.message,
    hint: f.hint,
  });
}
