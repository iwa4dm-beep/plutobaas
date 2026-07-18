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

async function verifyAdminToken(authHeader: string): Promise<VerifiedAdmin> {
  const url = `${serverPlutoUrl()}/auth/v1/user`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/json" },
    });
  } catch (err) {
    throw new Response(
      JSON.stringify({
        error: "auth_upstream_unreachable",
        message: "Authentication backend unreachable",
        hint: "Pluto backend health check করুন — /auth/v1/user endpoint accessible নয়।",
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  if (res.status === 401) {
    throw new Response(
      JSON.stringify({
        error: "unauthorized",
        message: "Session expired",
        hint: "আবার sign in করে token refresh করুন।",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  if (res.status === 403) {
    throw new Response(
      JSON.stringify({
        error: "forbidden",
        message: "Access denied",
        hint: "এই action-এর জন্য admin role দরকার।",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  if (!res.ok) {
    throw new Response(
      JSON.stringify({
        error: "auth_verify_failed",
        message: `Auth verification failed (HTTP ${res.status})`,
        hint: "Pluto backend logs check করুন।",
        status: res.status,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  const body = (await res.json().catch(() => null)) as
    | { user?: Record<string, unknown> }
    | Record<string, unknown>
    | null;
  const user = (body && "user" in (body as object) ? (body as { user: Record<string, unknown> }).user : (body as Record<string, unknown> | null)) ?? null;
  if (!user || typeof user !== "object") {
    throw new Response(
      JSON.stringify({ error: "unauthorized", message: "Invalid session", hint: "আবার sign in করুন।" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  const role = (user.role as string | undefined) ?? "";
  const isSuper = Boolean(user.is_superadmin);
  if (!isSuper && role !== "admin") {
    throw new Response(
      JSON.stringify({
        error: "forbidden",
        message: "Admin role required",
        hint: "আপনার account-এ admin privilege নেই। Root admin-এর সাথে যোগাযোগ করুন।",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
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
      throw new Response(
        JSON.stringify({ error: "unauthorized", message: "Missing bearer token" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    const admin = await verifyAdminToken(header);
    return next({ context: { plutoAdmin: admin } });
  });

export type PlutoAdminContext = { plutoAdmin: VerifiedAdmin };
