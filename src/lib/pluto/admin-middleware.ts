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

function readClientAuthHeader(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReadSession;
    return parsed?.access_token ? `Bearer ${parsed.access_token}` : null;
  } catch {
    return null;
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

export const requirePlutoAdmin = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const authHeader = readClientAuthHeader();
    return next({
      sendContext: { __plutoAuthHeader: authHeader ?? "" },
    });
  })
  .server(async ({ next, context }) => {
    const header = (context as { __plutoAuthHeader?: string }).__plutoAuthHeader ?? "";
    if (!header || !/^Bearer\s+\S+/i.test(header)) {
      throw authError(401, {
        error: "unauthorized",
        message: "Sign in required",
        hint: "Session token পাওয়া যায়নি। আবার sign in করুন।",
      });
    }
    const admin = await verifyAdminToken(header);
    return next({ context: { plutoAdmin: admin } });
  });

export type PlutoAdminContext = { plutoAdmin: VerifiedAdmin };
