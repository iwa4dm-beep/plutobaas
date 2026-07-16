// Server-side typed fetch wrapper for the Pluto VPS backend (api.timescard.cloud).
//
// Reads PLUTO_UPSTREAM_URL + PLUTO_SERVICE_ROLE_KEY from process.env inside
// server functions / route handlers. Never import this from client bundles.
//
// NOTE: This file is imported at module scope by `*.functions.ts` modules whose
// module scope is included in the client bundle (only handler bodies are
// stripped). We must therefore avoid any static `node:*` imports here — use
// Web Crypto (globalThis.crypto.subtle), which works in Node 20+, Workers,
// and browsers, so the module can safely load in either environment.

export type VpsMode = "service" | "user" | "anon";

export type VpsFetchOpts = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  mode?: VpsMode;
  token?: string; // user bearer, required when mode === "user"
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export function getVpsBaseUrl(): string {
  return (process.env.PLUTO_UPSTREAM_URL ?? "https://api.timescard.cloud").replace(/\/+$/, "");
}

/** True when `s` looks like a compact JWT — three base64url parts separated by dots. */
function looksLikeJwt(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = (typeof btoa !== "undefined")
    ? btoa(bin)
    : Buffer.from(bytes).toString("base64");
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlFromString(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

/** Mint an HS256 service-role JWT from PLUTO_JWT_SECRET using Web Crypto. */
async function mintServiceRoleJwt(secret: string, ttlSeconds = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlFromString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlFromString(JSON.stringify({
    sub: "00000000-0000-0000-0000-000000000000",
    role: "service_role",
    iss: process.env.PLUTO_JWT_ISSUER ?? "pluto",
    aud: "authenticated",
    iat: now,
    exp: now + ttlSeconds,
  }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await globalThis.crypto.subtle.sign("HMAC", key, data);
  const sig = b64urlFromBytes(new Uint8Array(sigBuf));
  return `${header}.${payload}.${sig}`;
}

// Cache a self-minted JWT for its TTL so we don't re-hash on every request.
let cachedMintedJwt: { token: string; exp: number } | null = null;

/** Return a service-role token usable against the Pluto admin API.
 *
 *  Priority:
 *   1. If PLUTO_SERVICE_ROLE_KEY looks like a compact JWT, use it as-is.
 *   2. Otherwise auto-mint an HS256 JWT from PLUTO_JWT_SECRET.
 *   3. Fall back to whatever was stored (best-effort).
 */
export async function getServiceRoleKey(): Promise<string | undefined> {
  const stored = (process.env.PLUTO_SERVICE_ROLE_KEY ?? "").trim();
  if (stored && looksLikeJwt(stored)) return stored;

  const secret = (process.env.PLUTO_JWT_SECRET ?? "").trim();
  if (secret) {
    const now = Math.floor(Date.now() / 1000);
    if (cachedMintedJwt && cachedMintedJwt.exp - now > 60) return cachedMintedJwt.token;
    const token = await mintServiceRoleJwt(secret, 3600);
    cachedMintedJwt = { token, exp: now + 3600 };
    return token;
  }
  return stored || undefined;
}

export function getAnonKey(): string | undefined {
  return process.env.PLUTO_ANON_KEY || undefined;
}

export class VpsError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function vpsFetch<T = unknown>(path: string, opts: VpsFetchOpts = {}): Promise<T> {
  const base = getVpsBaseUrl();
  const method = opts.method ?? "GET";
  const mode = opts.mode ?? "service";

  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.body != null) headers["content-type"] = "application/json";

  if (mode === "service") {
    const key = await getServiceRoleKey();
    if (!key) throw new VpsError("PLUTO_SERVICE_ROLE_KEY not configured", 500, null);
    headers.apikey = key;
    headers.authorization = `Bearer ${key}`;
  } else if (mode === "anon") {
    const key = getAnonKey();
    if (key) headers.apikey = key;
  } else if (mode === "user") {
    if (!opts.token) throw new VpsError("user token required", 401, null);
    headers.authorization = `Bearer ${opts.token}`;
    const anon = getAnonKey();
    if (anon) headers.apikey = anon;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
  const url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const msg = (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string")
        ? (parsed as { error: string }).error
        : `HTTP ${res.status}`;
      throw new VpsError(`${method} ${path} → ${msg}`, res.status, parsed);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}
