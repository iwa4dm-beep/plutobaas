/**
 * Admin auth middleware for sensitive server functions.
 *
 * How it works:
 *  - `.client()` reads the Pluto session from localStorage (browser) and
 *    forwards `Authorization: Bearer <access_token>` via `sendContext`.
 *    During SSR / prerender there is no `window`, so the header is empty
 *    and the server phase rejects.
 *  - `.server()` verifies the token by round-tripping to the Pluto backend
 *    (`/auth/v1/user`) and requires the caller to be an admin. This works
 *    for any token format because the backend is the source of truth.
 *
 * Attach to a server function with:
 *
 *   export const someFn = createServerFn({ method: "POST" })
 *     .middleware([requirePlutoAdmin])
 *     .inputValidator(...)
 *     .handler(async ({ context }) => { context.plutoAdmin.userId ... });
 */

import { createMiddleware } from "@tanstack/react-start";

const DEFAULT_PLUTO_URL = "https://api.timescard.cloud";
const SESSION_KEY = "pluto.session.v1";

type ReadSession = {
  access_token?: string;
  refresh_token?: string;
} | null;

function readClientSession(): (ReadSession & { expires_at?: number; user?: { id?: string } }) | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readClientAuthHeader(): string | null {
  const s = readClientSession();
  return s?.access_token ? `Bearer ${s.access_token}` : null;
}

/**
 * If the session is missing or within 30s of expiry, try a proactive refresh
 * BEFORE hitting the server-fn. Prevents most 401s from ever reaching the
 * user, so retry logic below is only needed for race conditions.
 */
async function refreshIfExpiringSoon(): Promise<void> {
  if (typeof window === "undefined") return;
  const s = readClientSession();
  if (!s?.refresh_token) return;
  const expMs = (s.expires_at ?? 0) * 1000;
  const skewMs = 30_000;
  if (expMs && expMs - Date.now() > skewMs) return;
  try {
    const { live } = await import("./live");
    await live.auth.refresh();
  } catch {
    /* swallow — server phase will produce the canonical 401 */
  }
}

function serverPlutoUrl(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {};
  return (
    env.PLUTO_URL ??
    env.VITE_PLUTO_URL ??
    DEFAULT_PLUTO_URL
  ).replace(/\/$/, "");
}

type VerifiedAdmin = {
  userId: string;
  email: string;
  role: "admin";
  raw: Record<string, unknown>;
};

/**
 * Throw a serializable Error the client can display.
 *
 * WHY NOT `throw new Response(...)`:
 *   TanStack's server-fn RPC boundary can't serialize a raw Response — it
 *   surfaces client-side as `Error: [object Response]` and blanks the page.
 *   We throw a normal Error whose `.message` is JSON so `describeError`
 *   parses it into a friendly toast/banner.
 */
function authError(status: number, payload: {
  error: string;
  message: string;
  hint?: string;
  details?: string;
}): Error {
  const err = new Error(JSON.stringify({ status, ...payload }));
  err.name = `PlutoAuthError_${status}`;
  return err;
}

async function verifyAdminToken(authHeader: string): Promise<VerifiedAdmin> {
  const url = `${serverPlutoUrl()}/auth/v1/user`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/json" },
    });
  } catch (err) {
    throw authError(503, {
      error: "auth_upstream_unreachable",
      message: "Authentication backend unreachable",
      hint: "Pluto backend health check করুন — /auth/v1/user endpoint accessible নয়।",
      details: err instanceof Error ? err.message : String(err),
    });
  }
  if (res.status === 401) {
    throw authError(401, {
      error: "unauthorized",
      message: "Session expired",
      hint: "আবার sign in করে token refresh করুন।",
    });
  }
  if (res.status === 403) {
    throw authError(403, {
      error: "forbidden",
      message: "Access denied",
      hint: "এই action-এর জন্য admin role দরকার।",
    });
  }
  if (!res.ok) {
    throw authError(502, {
      error: "auth_verify_failed",
      message: `Auth verification failed (HTTP ${res.status})`,
      hint: "Pluto backend logs check করুন।",
    });
  }
  const body = (await res.json().catch(() => null)) as
    | { user?: Record<string, unknown> }
    | Record<string, unknown>
    | null;
  const user = (body && "user" in (body as object) ? (body as { user: Record<string, unknown> }).user : (body as Record<string, unknown> | null)) ?? null;
  if (!user || typeof user !== "object") {
    throw authError(401, { error: "unauthorized", message: "Invalid session", hint: "আবার sign in করুন।" });
  }
  const role = (user.role as string | undefined) ?? "";
  const appMeta = (user.app_metadata as Record<string, unknown> | undefined) ?? {};
  const userMeta = (user.user_metadata as Record<string, unknown> | undefined) ?? {};
  const metaRole = String(appMeta.role ?? userMeta.role ?? "");
  const rolesArr = [
    ...(Array.isArray(appMeta.roles) ? (appMeta.roles as unknown[]) : []),
    ...(Array.isArray(userMeta.roles) ? (userMeta.roles as unknown[]) : []),
  ].map((r) => String(r));
  const isSuper =
    Boolean(user.is_superadmin) ||
    Boolean(appMeta.is_superadmin) ||
    Boolean(appMeta.superadmin) ||
    Boolean(userMeta.is_superadmin);
  const isAdmin =
    isSuper ||
    role === "admin" ||
    metaRole === "admin" ||
    metaRole === "superadmin" ||
    rolesArr.includes("admin") ||
    rolesArr.includes("superadmin");

  // Fallback: probe a privileged admin endpoint. If the backend allows the
  // caller to list workspaces, they ARE an admin — even if the /auth/v1/user
  // payload doesn't expose a role flag (Supabase's default response omits
  // custom claims when app_metadata is empty).
  let allowed = isAdmin;
  if (!allowed) {
    try {
      const probe = await fetch(`${serverPlutoUrl()}/admin/v1/workspaces?limit=1`, {
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" },
      });
      if (probe.ok) allowed = true;
    } catch {
      // ignore — fall through to 403
    }
  }
  if (!allowed) {
    throw authError(403, {
      error: "forbidden",
      message: "Admin role required",
      hint: "আপনার account-এ admin privilege নেই। Root admin-এর সাথে যোগাযোগ করুন।",
    });
  }
  return {
    userId: String(user.id ?? ""),
    email: String(user.email ?? ""),
    role: "admin",
    raw: user,
  };
}

const DEBUG_AUTH = () => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return env.PLUTO_DEBUG_AUTH === "1" || env.PLUTO_DEBUG_AUTH === "true";
};

function debugAuth(stage: string, info: Record<string, unknown>): void {
  if (!DEBUG_AUTH()) return;
  // Redact token payload — log only length + first 8 chars for correlation.
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(info)) {
    if (typeof v === "string" && /Bearer\s+\S+/i.test(v)) {
      const tok = v.replace(/^Bearer\s+/i, "");
      safe[k] = `Bearer ${tok.slice(0, 8)}…(${tok.length})`;
    } else {
      safe[k] = v;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[pluto-auth] ${stage}`, safe);
}

export const requirePlutoAdmin = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    // Proactively refresh a near-expiry token so most 401s never happen.
    await refreshIfExpiringSoon();
    let authHeader = readClientAuthHeader();
    const sess = readClientSession();
    debugAuth("client.phase", {
      hasWindow: typeof window !== "undefined",
      headerFound: !!authHeader,
      userId: sess?.user?.id ?? null,
      expiresIn: sess?.expires_at ? sess.expires_at * 1000 - Date.now() : null,
      route: typeof window !== "undefined" ? window.location.pathname : undefined,
      header: authHeader ?? "(empty)",
    });
    try {
      const result = await next({
        sendContext: { __plutoAuthHeader: authHeader ?? "" },
      });
      return result;
    } catch (err) {
      // Server phase surfaced a 401 — attempt a single refresh + retry so a
      // token that expired mid-flight doesn't force the user to re-sign-in.
      const isAuthErr = err instanceof Error && /PlutoAuthError_401|"status":\s*401/.test(err.message + " " + err.name);
      if (!isAuthErr || typeof window === "undefined") {
        // eslint-disable-next-line no-console
        if (isAuthErr) console.warn("[pluto-auth] client.401 (no-window, cannot retry)", {
          route: undefined, userId: sess?.user?.id ?? null,
        });
        throw err;
      }
      try {
        const { live } = await import("./live");
        const ok = await live.auth.refresh().then(() => true).catch(() => false);
        // eslint-disable-next-line no-console
        console.warn("[pluto-auth] client.401 → refresh+retry", {
          at: new Date().toISOString(),
          route: window.location.pathname,
          userId: sess?.user?.id ?? null,
          refreshed: ok,
        });
        if (!ok) throw err;
        authHeader = readClientAuthHeader();
        if (!authHeader) throw err;
        return await next({ sendContext: { __plutoAuthHeader: authHeader } });
      } catch {
        throw err;
      }
    }
  })
  .server(async ({ next, context }) => {
    let header = (context as { __plutoAuthHeader?: string }).__plutoAuthHeader ?? "";
    const source = header && /^Bearer\s+\S+/i.test(header) ? "sendContext" : "empty";
    // Nested server-fn calls: `.client()` runs on the server with no
    // localStorage and sends an empty header. Recover by reading the outer
    // request's Authorization header or the AsyncLocalStorage store set by
    // the outer verified caller.
    let recovered: "als" | "request-header" | null = null;
    if (!header || !/^Bearer\s+\S+/i.test(header)) {
      const { readIncomingAuthHeader } = await import("./admin-request-header.server");
      const incoming = readIncomingAuthHeader();
      if (incoming) {
        header = incoming;
        recovered = "als";
      }
    }
    debugAuth("server.phase", {
      source,
      recovered,
      finalHeader: header || "(empty)",
    });
    if (!header || !/^Bearer\s+\S+/i.test(header)) {
      let route: string | undefined;
      try {
        const mod = await import("@tanstack/react-start/server");
        route = new URL(mod.getRequest().url).pathname;
      } catch { /* not in request context */ }
      // eslint-disable-next-line no-console
      console.warn("[pluto-auth] server.401", {
        at: new Date().toISOString(),
        source, recovered, route,
      });
      throw authError(401, {
        error: "unauthorized",
        message: "Sign in required",
        hint: "Session token পাওয়া যায়নি। আবার sign in করুন।",
        details: DEBUG_AUTH() ? `source=${source} recovered=${recovered ?? "none"}` : undefined,
      });
    }
    const admin = await verifyAdminToken(header);
    debugAuth("server.verified", { userId: admin.userId, email: admin.email });
    // Stash the verified header in AsyncLocalStorage so nested server-fn
    // calls (whose `.client()` runs server-side without localStorage) can
    // recover it even when the outer HTTP request has no Authorization header.
    const { runWithAuthHeader } = await import("./admin-request-header.server");
    return runWithAuthHeader(header, () => next({ context: { plutoAdmin: admin } }));
  });

export type PlutoAdminContext = { plutoAdmin: VerifiedAdmin };

