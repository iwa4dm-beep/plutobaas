// Server-side typed fetch wrapper for the Pluto VPS backend (api.timescard.cloud).
//
// Reads PLUTO_UPSTREAM_URL + PLUTO_SERVICE_ROLE_KEY from process.env inside
// server functions / route handlers. Never import this from client bundles.

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

export function getServiceRoleKey(): string | undefined {
  return process.env.PLUTO_SERVICE_ROLE_KEY || undefined;
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
    const key = getServiceRoleKey();
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
