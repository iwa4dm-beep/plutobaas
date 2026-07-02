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

export type StatementInfo = {
  index: number;
  kind: string;
  target: string | null;
  sql: string;
};

export type SchemaDiff = {
  added: string[];
  removed: string[];
  changed: string[];
};

export type DryRunEntry = {
  version: string;
  name: string;
  reason: "pending" | "rolled_back" | "failed";
  statement_count: number;
  bytes: number;
  has_down: boolean;
  preview: string;
  statements: StatementInfo[];
  diff: SchemaDiff;
  before_snapshot_size: number;
  after_snapshot_size: number;
  simulation_error: string | null;
};

export type AuditEvent = {
  id: string;
  ts: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  target: string | null;
  status: "ok" | "error" | "dry_run";
  metadata: Record<string, unknown>;
  ip: string | null;
};

export type AuditPage = {
  items: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
};

export type AuditQuery = {
  action?: string;
  actor?: string;
  actor_id?: string;
  status?: "ok" | "error" | "dry_run";
  q?: string;
  workspace_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
};

export const live = {
  migrations: {
    list: () => api<{ migrations: MigrationEntry[] }>("/admin/v1/migrations/", { service: true }),
    dryRun: (detailed = true) => api<{ dry_run: true; plan: DryRunEntry[] }>(
      "/admin/v1/migrations/run",
      { method: "POST", service: true, body: JSON.stringify({ dry_run: true, detailed }) }
    ),
    runPending: () => api<{ applied: string[]; failed: { version: string; error: string }[] }>(
      "/admin/v1/migrations/run",
      { method: "POST", service: true, body: JSON.stringify({ dry_run: false }) }
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
  audit: {
    list: (params: AuditQuery = {}) => {
      const qs = new URLSearchParams();
      if (params.action)       qs.set("action",       params.action);
      if (params.actor)        qs.set("actor",        params.actor);
      if (params.actor_id)     qs.set("actor_id",     params.actor_id);
      if (params.status)       qs.set("status",       params.status);
      if (params.q)            qs.set("q",            params.q);
      if (params.workspace_id) qs.set("workspace_id", params.workspace_id);
      if (params.since)        qs.set("since",        params.since);
      if (params.until)        qs.set("until",        params.until);
      qs.set("limit",  String(params.limit  ?? 50));
      qs.set("offset", String(params.offset ?? 0));
      return api<AuditPage>(`/admin/v1/audit?${qs.toString()}`, { service: true });
    },
  },
  workspaces: {
    list: () => api<{ workspaces: Workspace[] }>("/admin/v1/workspaces/", { service: true }),
    create: (slug: string, name: string) =>
      api<{ id: string; slug: string; name: string; keys: { anon: string; service_role: string } }>(
        "/admin/v1/workspaces/",
        { method: "POST", service: true, body: JSON.stringify({ slug, name }) }
      ),
    keys: (id: string) => api<{ keys: WorkspaceKey[] }>(`/admin/v1/workspaces/${id}/keys`, { service: true }),
    mintKey: (id: string, kind: "anon" | "service_role", name: string) =>
      api<{ id: string; kind: string; plaintext: string }>(
        `/admin/v1/workspaces/${id}/keys`,
        { method: "POST", service: true, body: JSON.stringify({ kind, name }) }
      ),
    revokeKey: (id: string, keyId: string) =>
      api(`/admin/v1/workspaces/${id}/keys/${keyId}/revoke`, { method: "POST", service: true }),
    members: (id: string) => api<{ members: WorkspaceMember[] }>(`/admin/v1/workspaces/${id}/members`, { service: true }),
  },
  sql: {
    run: (sql: string, opts: { read_only?: boolean; workspace_id?: string; params?: unknown[] } = {}) =>
      api<SqlRunResponse>("/admin/v1/sql/run", {
        method: "POST", service: true,
        body: JSON.stringify({
          sql,
          read_only: opts.read_only ?? false,
          workspace_id: opts.workspace_id,
          params: opts.params ?? [],
        }),
      }),
    explain: (sql: string) => api<{ plan: unknown }>("/admin/v1/sql/explain", {
      method: "POST", service: true, body: JSON.stringify({ sql }),
    }),
    history: (params: SqlHistoryQuery = {}) => {
      const qs = new URLSearchParams();
      if (params.workspace_id) qs.set("workspace_id", params.workspace_id);
      if (params.status)       qs.set("status", params.status);
      if (params.read_only != null) qs.set("read_only", String(params.read_only));
      if (params.q)            qs.set("q", params.q);
      qs.set("limit",  String(params.limit  ?? 50));
      qs.set("offset", String(params.offset ?? 0));
      return api<SqlHistoryPage>(`/admin/v1/sql/history?${qs.toString()}`, { service: true });
    },
    historyEntry: (id: string) => api<SqlHistoryEntry & { sql: string }>(`/admin/v1/sql/history/${id}`, { service: true }),
  },
  schema: {
    introspect: () => api<{ tables: SchemaTable[] }>("/admin/v1/schema", { service: true }),
    summary:    () => api<SchemaSummary>("/admin/v1/schema/summary"),
    openapi:    () => api<Record<string, unknown>>("/admin/v1/schema/openapi.json"),
  },

  // ---- Edge Functions ----
  // Serverless JS running in isolated Node worker threads on the Pluto
  // instance. Handlers receive `ctx.user` (from the caller's Bearer JWT)
  // and can talk to Auth, REST, and Storage via injected fetch helpers.
  // Deploy/list/delete are admin-only; invoke honors the function's own
  // `public` flag plus per-function RLS.
  functions: {
    list: () => api<{ items: EdgeFunctionMeta[] }>("/functions/v1/list", { service: true }),
    deploy: (opts: EdgeFunctionDeploy) =>
      api<{ slug: string; version: number }>("/functions/v1/deploy", {
        method: "POST", service: true, body: JSON.stringify(opts),
      }),
    remove: (slug: string) =>
      api(`/functions/v1/${encodeURIComponent(slug)}`, { method: "DELETE", service: true }),
    /**
     * Invoke an edge function. Uses the caller's user session bearer when
     * available, else falls back to the anon key — same identity the
     * function's ctx.user will observe. `body` is JSON-serialized; pass a
     * `Blob`/`ArrayBuffer` via `rawBody` for binary payloads.
     */
    invoke: async <T = unknown>(
      slug: string,
      opts: { method?: string; body?: unknown; headers?: Record<string, string>; rawBody?: BodyInit } = {}
    ): Promise<{ status: number; data: T; headers: Record<string, string> }> => {
      const cfg = liveConfig();
      if (!cfg) throw new Error("Pluto backend not configured");
      const method = opts.method ?? "POST";
      const hasBody = opts.rawBody !== undefined || opts.body !== undefined;
      const headers: Record<string, string> = {
        ...bearer(false),
        ...(hasBody && opts.rawBody === undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      };
      const res = await fetch(`${cfg.url.replace(/\/$/, "")}/functions/v1/invoke/${encodeURIComponent(slug)}`, {
        method,
        headers,
        body: opts.rawBody ?? (hasBody ? JSON.stringify(opts.body) : undefined),
      });
      const ct = res.headers.get("content-type") ?? "";
      const data = (ct.includes("application/json") ? await res.json() : await res.text()) as T;
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => { h[k] = v; });
      return { status: res.status, data, headers: h };
    },
  },


  // ---- Real auth (session / JWT / refresh / RBAC) ----
  //
  // These call the /auth/v1/* endpoints exposed by the server. The
  // returned session is persisted to localStorage under SESSION_KEY so
  // that subsequent `api()` calls forward the Bearer JWT.
  auth: {
    signUp: async (email: string, password: string) => {
      const r = await api<{ user: AuthUser; session: AuthSession }>("/auth/v1/sign-up", {
        method: "POST", body: JSON.stringify({ email, password }),
      });
      persistSession(r.session, r.user);
      return r;
    },
    signIn: async (email: string, password: string) => {
      const r = await api<{ user: AuthUser; session: AuthSession }>("/auth/v1/sign-in", {
        method: "POST", body: JSON.stringify({ email, password }),
      });
      persistSession(r.session, r.user);
      return r;
    },
    refresh: async () => {
      const sess = readSession(); if (!sess) throw new Error("no_session");
      const r = await api<{ session: AuthSession }>("/auth/v1/refresh", {
        method: "POST", body: JSON.stringify({ refresh_token: sess.refresh_token }),
      });
      persistSession(r.session, sess.user as AuthUser);
      return r.session;
    },
    signOut: async () => {
      try { await api("/auth/v1/sign-out", { method: "POST" }); } catch { /* clear anyway */ }
      localStorage.removeItem(SESSION_KEY);
    },
    me: () => api<{ user: AuthUser }>("/auth/v1/user"),
    session: (): (AuthSession & { user: AuthUser }) | null => {
      const s = readSession();
      return s ? { ...s, user: s.user as AuthUser } : null;
    },
  },

  // ---- Admin surfaces (used by dashboard pages) ----
  admin: {
    users: {
      list:   () => api<AdminUser[]>("/admin/v1/users", { service: true }),
      update: (id: string, patch: { role?: "admin" | "user"; email_verified?: boolean }) =>
        api(`/admin/v1/users/${id}`, { method: "PATCH", service: true, body: JSON.stringify(patch) }),
      remove: (id: string) => api(`/admin/v1/users/${id}`, { method: "DELETE", service: true }),
    },
    logs:  (params: { source?: string; level?: string; limit?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.source) qs.set("source", params.source);
      if (params.level)  qs.set("level",  params.level);
      qs.set("limit", String(params.limit ?? 100));
      return api<LogEntry[]>(`/admin/v1/logs?${qs.toString()}`, { service: true });
    },
    stats: () => api<{ users: number; buckets: number; objects: number; storage_bytes: number }>(
      "/admin/v1/stats", { service: true }
    ),
    apiKeys: {
      list:   (wsId: string) => api<{ items: WorkspaceKey[] }>(`/admin/v1/workspaces/${wsId}/keys`, { service: true }),
      mint:   (wsId: string, name: string, kind: "anon" | "service_role") =>
        api<{ id: string; kind: string; name: string; key_prefix: string; plaintext: string }>(
          `/admin/v1/workspaces/${wsId}/keys`,
          { method: "POST", service: true, body: JSON.stringify({ name, kind }) },
        ),
      revoke: (wsId: string, keyId: string) =>
        api(`/admin/v1/workspaces/${wsId}/keys/${keyId}`, { method: "DELETE", service: true }),
    },
    settings: {
      list:   (wsId?: string) => {
        const qs = wsId ? `?workspace_id=${wsId}` : "";
        return api<{ items: SettingRow[] }>(`/admin/v1/settings${qs}`, { service: true });
      },
      upsert: (row: { key: string; value: unknown; is_secret?: boolean; workspace_id?: string }) =>
        api("/admin/v1/settings", { method: "PUT", service: true, body: JSON.stringify(row) }),
      remove: (key: string, wsId?: string) =>
        api(`/admin/v1/settings/${encodeURIComponent(key)}${wsId ? `?workspace_id=${wsId}` : ""}`,
            { method: "DELETE", service: true }),
    },
  },
};

// ---- Session persistence helpers (used by live.auth.*) ----
function persistSession(s: AuthSession, u: AuthUser): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, user: u }));
}

// ---- Auth / admin type surface ----
export type AuthUser = { id: string; email: string; role: "admin" | "user"; email_verified?: boolean };
export type AuthSession = { access_token: string; refresh_token: string; expires_at: number; user?: AuthUser };
export type AdminUser = AuthUser & { created_at: string };
export type LogEntry = {
  id: string; ts: string; source: string; level: string;
  message: string; user_id: string | null; metadata: unknown;
};
export type SettingRow = { key: string; value: unknown; is_secret: boolean; updated_at: string };

export type Workspace = {
  id: string; slug: string; name: string;
  created_at: string; archived_at: string | null;
  member_count: number; active_keys: number;
};
export type WorkspaceKey = {
  id: string; kind: "anon" | "service_role"; name: string;
  key_prefix: string; created_at: string;
  revoked_at: string | null; last_used_at: string | null; use_count: number;
};
export type WorkspaceMember = { user_id: string; role: string; created_at: string; email: string };

export type SqlColumn = { name: string; type_oid: number };
export type SqlResult = {
  command: string | null; row_count: number | null;
  rows: unknown[]; columns: SqlColumn[]; truncated: boolean;
};
export type SqlRunResponse = {
  history_id: string | null; duration_ms: number;
  read_only: boolean; results: SqlResult[];
};
export type SqlHistoryEntry = {
  id: string; workspace_id: string | null; user_id: string | null;
  user_email: string | null; sql_preview: string; sql_bytes: number;
  read_only: boolean; status: "ok" | "error";
  row_count: number | null; duration_ms: number;
  error: string | null; ran_at: string;
};
export type SqlHistoryPage = { items: SqlHistoryEntry[]; total: number; limit: number; offset: number };
export type SqlHistoryQuery = {
  workspace_id?: string; status?: "ok" | "error";
  read_only?: boolean; q?: string; limit?: number; offset?: number;
};

// ---- Schema (auto REST) ----
export type SchemaColumn = {
  name: string; data_type: string; udt_name: string;
  is_nullable: boolean; has_default: boolean;
  is_primary_key: boolean; is_unique: boolean;
  references: { table: string; column: string } | null;
};
export type SchemaTable = {
  schema: string; name: string; comment: string | null;
  columns: SchemaColumn[]; primary_key: string[];
  rls_enabled: boolean; policies: string[];
  workspace_scoped: boolean;
  privileges: { anon: string[]; authenticated: string[]; service_role: string[] };
};
export type SchemaEndpoint = {
  table: string; workspace_scoped: boolean; rls_enabled: boolean;
  primary_key: string[]; columns: string[]; methods: string[]; base: string;
};
export type SchemaSummary = {

  workspace_id: string | null;
  role: "service_role" | "authenticated";
  endpoints: SchemaEndpoint[];
};


// -------- Realtime helper (WebSocket wrapper) --------
//
// Subscribes to one broadcast channel and calls `onEvent` for each
// message. Returns an unsubscribe function. Silently no-ops if the
// backend is not configured.

export type RealtimeEvent = { channel: string; event: string; payload: unknown; ts?: string };

export function subscribe(channel: string, onEvent: (e: RealtimeEvent) => void): () => void {
  const cfg = liveConfig();
  if (!cfg) return () => {};
  const wsUrl = cfg.url.replace(/^http/, "ws").replace(/\/$/, "") +
    `/realtime/v1/?apikey=${encodeURIComponent(cfg.serviceKey ?? cfg.anonKey)}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => {
      retry = 0;
      ws?.send(JSON.stringify({ type: "subscribe", channel }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; channel?: string; event?: string; payload?: unknown; ts?: string };
        if (msg.type === "broadcast" && msg.channel === channel && msg.event) {
          onEvent({ channel, event: msg.event, payload: msg.payload, ts: msg.ts });
        }
      } catch { /* ignore malformed frames */ }
    });
    ws.addEventListener("close", () => {
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * 2 ** retry);
    });
    ws.addEventListener("error", () => ws?.close());
  };
  connect();
  return () => { closed = true; ws?.close(); };
}
