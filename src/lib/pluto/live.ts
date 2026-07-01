// Live-endpoint layer for the Pluto dashboard.
//
// If `VITE_PLUTO_URL` and `VITE_PLUTO_ANON_KEY` are set, we talk to a
// real Pluto backend (REST / auth / storage / realtime / functions).
// If they are unset, `isLive()` returns false and callers keep using
// the mock client in `client.ts` — so the dashboard works with no
// backend configured.

export type LiveConfig = {
  url: string;
  anonKey: string;
  serviceKey?: string;      // optional — only set for admin operations
};

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const URL_ = env.VITE_PLUTO_URL;
const ANON_KEY = env.VITE_PLUTO_ANON_KEY;

// Service role is optional and only used by admin surfaces (migrations,
// job tokens, edge deploy). Prefer supplying it at runtime via the
// dashboard settings page rather than baking into the bundle.
const SERVICE_KEY = env.VITE_PLUTO_SERVICE_KEY;

export function isLive(): boolean {
  return !!(URL_ && ANON_KEY);
}

export function liveConfig(): LiveConfig | null {
  if (!isLive()) return null;
  return { url: URL_!, anonKey: ANON_KEY!, serviceKey: SERVICE_KEY };
}

const SESSION_KEY = "pluto.session.v1";

function readSession(): { access_token: string; refresh_token: string; user: unknown; expires_at: number } | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null"); }
  catch { return null; }
}

function bearer(useService = false): Record<string, string> {
  const cfg = liveConfig()!;
  const key = useService && cfg.serviceKey ? cfg.serviceKey : cfg.anonKey;
  const sess = readSession();
  const auth = useService && cfg.serviceKey ? cfg.serviceKey : (sess?.access_token ?? cfg.anonKey);
  return {
    apikey: key,
    Authorization: `Bearer ${auth}`,
  };
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { service?: boolean } = {}
): Promise<T> {
  const cfg = liveConfig();
  if (!cfg) throw new Error("Pluto backend not configured (set VITE_PLUTO_URL & VITE_PLUTO_ANON_KEY)");
  const { service, headers, ...rest } = init;
  const res = await fetch(cfg.url.replace(/\/$/, "") + path, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...bearer(service),
      ...(headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const message = typeof json === "object" && json && "message" in json
      ? String((json as { message?: unknown }).message)
      : (typeof json === "string" ? json : `HTTP ${res.status}`);
    throw new Error(message);
  }
  return json as T;
}

export type MigrationEntry = {
  version: string;
  name: string;
  status: "applied" | "pending" | "drift" | "rolled_back" | "failed" | "missing";
  file_checksum: string | null;
  db_checksum: string | null;
  applied_at: string | null;
  duration_ms: number | null;
  has_down: boolean;
  error: string | null;
};

export type JobToken = {
  id: string;
  name: string;
  scope: string[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
};

export const live = {
  migrations: {
    list: () => api<{ migrations: MigrationEntry[] }>("/admin/v1/migrations/", { service: true }),
    runPending: () => api<{ applied: string[]; failed: { version: string; error: string }[] }>(
      "/admin/v1/migrations/run", { method: "POST", service: true }
    ),
    rerun: (version: string) => api(`/admin/v1/migrations/${version}/rerun`, { method: "POST", service: true }),
    rollback: (version: string) => api(`/admin/v1/migrations/${version}/rollback`, { method: "POST", service: true }),
  },
  jobs: {
    list: () => api<JobToken[]>("/jobs/v1/tokens", { service: true }),
    mint: (name: string, scope: string[], ttl_seconds: number) => api<{ id: string; name: string; expires_at: string; token: string }>(
      "/jobs/v1/tokens",
      { method: "POST", service: true, body: JSON.stringify({ name, scope, ttl_seconds }) }
    ),
    revoke: (id: string) => api(`/jobs/v1/tokens/${id}`, { method: "DELETE", service: true }),
  },
};
