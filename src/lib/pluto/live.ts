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

// Boot-time migration run history (populated by src/db/migrate.ts under
// PLUTO_BOOT_ACTOR=boot). Surfaced by /admin/v1/migrations/last-boot.
export type BootRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  actor: string;
  mode: "apply" | "dry-run" | "plan" | string;
  host: string | null;
  version_tag: string | null;
  pending: string[];
  drift: string[];
  applied: string[];
  failed: { version: string; error: string }[];
  duration_ms: number;
  status: "ok" | "error" | string;
  error: string | null;
  lock_acquired: boolean;
  advisory_key: string | null;
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
    lastBoot: () => api<{ run: BootRun | null }>("/admin/v1/migrations/last-boot", { service: true }),
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
    /** Redirect the browser to the OAuth provider. */
    signInWithOAuth: (provider: OAuthProvider, opts?: { redirectTo?: string }) =>
      signInWithOAuth(provider, opts),
    /** Consume `#access_token=...` fragment on redirect-back. Call on app boot. */
    completeOAuthRedirect: () => completeOAuthRedirect(),
  },

  /** Realtime — subscribe to broadcast channels or Postgres row changes. */
  realtime: {
    subscribe: (channel: string, cb: (e: RealtimeEvent) => void, opts?: { onStatus?: (s: RealtimeStatus) => void }) => subscribe(channel, cb, opts),
    subscribeTable: (spec: string, cb: (c: RealtimeChange) => void, opts?: { onStatus?: (s: RealtimeStatus) => void }) => subscribeTable(spec, cb, opts),
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
// Two subscription modes over a single reconnecting socket:
//   • `subscribe(channel, cb)`         — pub/sub broadcast channels
//   • `subscribeTable(spec, cb)`       — Postgres row change events
//                                        (INSERT/UPDATE/DELETE) from
//                                        `pluto_enable_realtime(table)`.
//
// `spec` is `"schema:table"` or `"schema:table:col=eq.value"`.

export type RealtimeEvent = { channel: string; event: string; payload: unknown; ts?: string };
export type RealtimeChange = {
  channel: string;
  event: "INSERT" | "UPDATE" | "DELETE";
  record: Record<string, unknown>;
};

// Fatal auth codes: server-side realtime handshake rejects these
// permanently; the client should stop reconnecting until the operator
// updates the API key or JWT.
export type RealtimeAuthError = "admin_required" | "admin_role_required" | "invalid_api_key";
export type RealtimeStatus =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "closed"; reason?: string }
  | { kind: "auth_error"; error: RealtimeAuthError; message: string };

type WsMsg = {
  type?: string; channel?: string; event?: string;
  payload?: unknown; record?: Record<string, unknown>; ts?: string;
  error?: string; fatal?: boolean;
};

type SubscribeOpts = { onStatus?: (s: RealtimeStatus) => void };

const AUTH_ERROR_MESSAGES: Record<RealtimeAuthError, string> = {
  admin_required:      "Realtime requires the service_role API key. Update VITE_PLUTO_SERVICE_KEY to view live system:* channels.",
  admin_role_required: "The signed-in user must have role='admin' to subscribe to system:* channels. Sign in with an admin account.",
  invalid_api_key:     "The API key was rejected by the realtime server. Update VITE_PLUTO_ANON_KEY / VITE_PLUTO_SERVICE_KEY.",
};

function openSocket(
  handler: (m: WsMsg) => void,
  onOpen: (send: (m: unknown) => void) => void,
  opts: SubscribeOpts = {},
): () => void {
  const cfg = liveConfig();
  if (!cfg) return () => {};
  const wsUrl = cfg.url.replace(/^http/, "ws").replace(/\/$/, "") +
    `/realtime/v1/?apikey=${encodeURIComponent(cfg.serviceKey ?? cfg.anonKey)}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let halted = false;              // set on fatal auth failure — no more retries
  let retry = 0;

  const status = (s: RealtimeStatus) => { try { opts.onStatus?.(s); } catch { /* swallow */ } };

  const connect = () => {
    if (closed || halted) return;
    status({ kind: "connecting" });
    ws = new WebSocket(wsUrl);
    const send = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    ws.addEventListener("open", () => { retry = 0; status({ kind: "open" }); onOpen(send); });
    ws.addEventListener("message", (ev) => {
      let msg: WsMsg;
      try { msg = JSON.parse(ev.data) as WsMsg; } catch { return; }
      // Fatal auth error from server — surface, halt, don't reconnect.
      if (msg.type === "error" && msg.fatal && (msg.error === "admin_required" || msg.error === "admin_role_required")) {
        halted = true;
        const err = msg.error;
        status({ kind: "auth_error", error: err, message: AUTH_ERROR_MESSAGES[err] });
        try { ws?.close(); } catch { /* ignore */ }
        return;
      }
      handler(msg);
    });
    ws.addEventListener("close", (ev) => {
      if (closed) return;
      // 1008 = policy violation — server rejected auth. Do not retry.
      if (ev.code === 1008) {
        halted = true;
        const reason = (ev.reason || "invalid_api_key") as RealtimeAuthError;
        const known = (reason === "admin_required" || reason === "admin_role_required" || reason === "invalid_api_key")
          ? reason : "invalid_api_key";
        status({ kind: "auth_error", error: known, message: AUTH_ERROR_MESSAGES[known] });
        return;
      }
      status({ kind: "closed", reason: ev.reason });
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * 2 ** retry);
    });
    ws.addEventListener("error", () => ws?.close());
  };
  connect();
  return () => { closed = true; ws?.close(); };
}

export function subscribe(
  channel: string,
  onEvent: (e: RealtimeEvent) => void,
  opts: SubscribeOpts = {},
): () => void {
  return openSocket(
    (msg) => {
      if (msg.type === "broadcast" && msg.channel === channel && msg.event) {
        onEvent({ channel, event: msg.event, payload: msg.payload, ts: msg.ts });
      }
    },
    (send) => send({ type: "subscribe", channel }),
    opts,
  );
}

/**
 * Subscribe to Postgres row-change events for a table. Requires the DBA
 * to have run `select pluto_enable_realtime('schema.table')`.
 *   subscribeTable("public:notes", cb)
 *   subscribeTable("public:notes:user_id=eq.<uuid>", cb)
 */
export function subscribeTable(
  spec: string,
  onChange: (c: RealtimeChange) => void,
  opts: SubscribeOpts = {},
): () => void {
  const baseChannel = spec.split(":").slice(0, 2).join(":");
  return openSocket(
    (msg) => {
      if (msg.type === "change" && msg.channel === baseChannel && msg.event && msg.record) {
        onChange({
          channel: baseChannel,
          event: msg.event as RealtimeChange["event"],
          record: msg.record,
        });
      }
    },
    (send) => send({ type: "subscribe", channel: spec }),
    opts,
  );
}


// -------- OAuth helpers (browser redirect flow) --------
//
// `signInWithOAuth("google")` sends the tab to the provider. After
// consent the server redirects back to `redirectTo` with tokens in the
// URL fragment. Call `completeOAuthRedirect()` on app boot to consume
// the fragment and persist the session.

export type OAuthProvider = "google" | "github";

export function signInWithOAuth(
  provider: OAuthProvider,
  opts: { redirectTo?: string } = {},
): void {
  const cfg = liveConfig();
  if (!cfg) throw new Error("Pluto backend not configured");
  const redirect_to = opts.redirectTo ?? window.location.origin + window.location.pathname;
  const url = new URL(cfg.url.replace(/\/$/, "") + `/auth/v1/oauth/${provider}`);
  url.searchParams.set("redirect_to", redirect_to);
  url.searchParams.set("apikey", cfg.anonKey);
  window.location.href = url.toString();
}

export function completeOAuthRedirect(): (AuthSession & { user: AuthUser }) | null {
  if (typeof window === "undefined" || !window.location.hash) return null;
  const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const access_token  = frag.get("access_token");
  const refresh_token = frag.get("refresh_token");
  const expires_in    = frag.get("expires_in");
  if (!access_token || !refresh_token) return null;

  // Decode the JWT payload to pull user identity — no verification needed
  // client-side; the server re-checks the signature on every call.
  let user: AuthUser = { id: "", email: "", role: "user" };
  try {
    const [, payload] = access_token.split(".");
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub: string; email: string; role: "admin" | "user";
    };
    user = { id: claims.sub, email: claims.email, role: claims.role };
  } catch { /* fall through with empty user */ }

  const expires_at = Math.floor(Date.now() / 1000) + Number(expires_in ?? 3600);
  const session: AuthSession = { access_token, refresh_token, expires_at };
  persistSession(session, user);
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return { ...session, user };
}

// ---- Edge Function types ----
export type EdgeFunctionMeta = {
  slug: string;
  public: boolean;
  timeout_ms: number;
  memory_mb: number;
  allow_hosts: string[];
  updated_at: string;
  version?: number;
};
export type EdgeFunctionDeploy = {
  slug: string;
  code: string;
  public?: boolean;
  timeout_ms?: number;
  memory_mb?: number;
  allow_hosts?: string[];
};

// ============================================================
// Phase 15 & 16 SDK surface — MFA · SSO · Templates · Push · AI
// ============================================================
// These are thin wrappers over `api(...)`. Handlers return 501 until the
// corresponding phase milestone (15.1+, 16.1+); the surface is stable so
// frontends can be built now and lit up as milestones land.

// ---- Phase 15: MFA ----
export type MfaFactor = {
  id: string; factor_type: "totp" | "webauthn";
  friendly_name: string | null;
  status: "unverified" | "verified" | "revoked";
  created_at: string; last_used_at: string | null;
};
export type MfaEnrollResponse = {
  factor_id: string; factor_type: "totp" | "webauthn";
  otpauth_url: string; secret: string;
};

export const mfa = {
  list:            () => api<{ factors: MfaFactor[] }>("/auth/v1/mfa/factors"),
  enroll:          (friendly_name?: string) =>
    api<MfaEnrollResponse>("/auth/v1/mfa/enroll", { method: "POST", body: JSON.stringify({ friendly_name }) }),
  verify:          (factor_id: string, code: string) =>
    api<{ ok: true }>("/auth/v1/mfa/verify", { method: "POST", body: JSON.stringify({ factor_id, code }) }),
  challenge:       (factor_id: string) =>
    api<{ challenge_id: string; expires_at: string }>("/auth/v1/mfa/challenge", { method: "POST", body: JSON.stringify({ factor_id }) }),
  verifyChallenge: (challenge_id: string, code: string) =>
    api<{ access_token: string; refresh_token: string }>("/auth/v1/mfa/challenge/verify", { method: "POST", body: JSON.stringify({ challenge_id, code }) }),
  revoke:          (factor_id: string) =>
    api<{ ok: true }>(`/auth/v1/mfa/factors/${factor_id}`, { method: "DELETE" }),
  recoveryCodes:   () =>
    api<{ codes: string[] }>("/auth/v1/mfa/recovery-codes", { method: "POST" }),
};

// ---- Phase 15: SSO ----
export type SsoProvider = {
  id: string; slug: string; display_name: string;
  protocol: "oidc" | "saml"; enabled: boolean;
  config: Record<string, unknown>; created_at: string;
};

export const sso = {
  list:   () => api<{ providers: SsoProvider[] }>("/auth/v1/sso/providers"),
  create: (p: Partial<SsoProvider>) =>
    api<SsoProvider>("/auth/v1/sso/providers", { method: "POST", body: JSON.stringify(p), service: true }),
  update: (id: string, p: Partial<SsoProvider>) =>
    api<SsoProvider>(`/auth/v1/sso/providers/${id}`, { method: "PATCH", body: JSON.stringify(p), service: true }),
  remove: (id: string) =>
    api<{ ok: true }>(`/auth/v1/sso/providers/${id}`, { method: "DELETE", service: true }),
  startUrl: (slug: string, redirect_to?: string) => {
    const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
    const u = new URL(cfg.url.replace(/\/$/, "") + `/auth/v1/sso/${slug}/start`);
    if (redirect_to) u.searchParams.set("redirect_to", redirect_to);
    u.searchParams.set("apikey", cfg.anonKey);
    return u.toString();
  },
};

// ---- Phase 15: Templates ----
export type CommsTemplate = {
  id: string; slug: string; channel: "email" | "sms" | "push";
  version: number; is_active: boolean;
  subject: string | null; body_text: string | null; body_html: string | null;
  variables: string[]; created_at: string;
};

export const templates = {
  list:      () => api<{ templates: CommsTemplate[] }>("/templates/v1"),
  create:    (t: Partial<CommsTemplate>) =>
    api<CommsTemplate>("/templates/v1", { method: "POST", body: JSON.stringify(t) }),
  get:       (slug: string) => api<CommsTemplate>(`/templates/v1/${slug}`),
  versions:  (slug: string) => api<{ versions: CommsTemplate[] }>(`/templates/v1/${slug}/versions`),
  newVersion:(slug: string, t: Partial<CommsTemplate>) =>
    api<CommsTemplate>(`/templates/v1/${slug}/versions`, { method: "POST", body: JSON.stringify(t) }),
  activate:  (slug: string, version: number) =>
    api<{ ok: true }>(`/templates/v1/${slug}/activate/${version}`, { method: "POST" }),
  preview:   (slug: string, vars: Record<string, unknown>) =>
    api<{ subject: string | null; body_text: string; body_html: string | null }>(
      `/templates/v1/${slug}/preview`, { method: "POST", body: JSON.stringify({ vars }) }),
  remove:    (slug: string) => api<{ ok: true }>(`/templates/v1/${slug}`, { method: "DELETE" }),
};

// ---- Phase 15: Push ----
export type PushDevice = {
  id: string; platform: "ios" | "android" | "web"; token: string;
  bundle_id: string | null; app_version: string | null;
  disabled_at: string | null; last_seen_at: string; created_at: string;
};

export const push = {
  listDevices: () => api<{ devices: PushDevice[] }>("/push/v1/devices"),
  register:    (d: Omit<PushDevice, "id" | "disabled_at" | "last_seen_at" | "created_at">) =>
    api<PushDevice>("/push/v1/devices", { method: "POST", body: JSON.stringify(d) }),
  remove:      (id: string) => api<{ ok: true }>(`/push/v1/devices/${id}`, { method: "DELETE" }),
  send:        (msg: { device_id?: string; user_id?: string; title?: string; body?: string; data?: Record<string, unknown> }) =>
    api<{ id: string; status: string }>("/push/v1/send", { method: "POST", body: JSON.stringify(msg) }),
  messages:    (limit = 50) => api<{ messages: unknown[] }>(`/push/v1/messages?limit=${limit}`),
};

// ---- Phase 16: AI & Vector ----
export type AiStatus = {
  module: "ai"; phase: string; gateway_ready: boolean;
  vector_allow: string[]; drivers: string[];
};
export type EmbeddingsResponse = {
  embeddings: number[][]; model: string;
  usage: { tokens_in: number; tokens_out: 0 };
};
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type VectorHit = {
  id: string; content: string;
  metadata: Record<string, unknown>; distance: number;
};

export const ai = {
  status:  () => api<AiStatus>("/ai/v1/status"),
  embed:   (input: string | string[], opts: { model?: string; provider?: string } = {}) =>
    api<EmbeddingsResponse>("/ai/v1/embeddings", { method: "POST", body: JSON.stringify({ input, ...opts }) }),
  chat:    (messages: ChatMessage[], opts: { model?: string; provider?: string; temperature?: number; max_tokens?: number } = {}) =>
    api<{ id: string; message: ChatMessage; usage: { tokens_in: number; tokens_out: number } }>(
      "/ai/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages, ...opts }) }),
  vectorSearch: (collection: string, req: {
      vector?: number[]; query?: string; k?: number;
      filter?: Record<string, unknown>; distance?: "cosine" | "l2" | "ip";
    }) =>
    api<{ hits: VectorHit[] }>(`/ai/v1/vector/${collection}/search`, { method: "POST", body: JSON.stringify(req) }),
  usage:   (params: { limit?: number; workspace_id?: string; actor_id?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
    return api<{ rows: unknown[]; total: number }>(`/ai/v1/usage${qs.toString() ? "?" + qs.toString() : ""}`);
  },
};

// ---- Integration health (Phase 15/16) ----
export type IntegrationCheck = { name: string; ok: boolean; detail?: string };
export type IntegrationModule = {
  module: string; enabled: boolean; env_flag: string; ready: boolean;
  checks: IntegrationCheck[]; endpoints: string[];
  throttle?: Array<{ key: string; hits: number; max: number; remaining: number; window_sec: number; reset_in_sec: number; blocked: number }>;
};
export type IntegrationHealth = {
  ok: boolean; generated_at: string; modules: IntegrationModule[];
};
export const integrations = {
  health: () => api<IntegrationHealth>("/admin/v1/integrations/health", { service: true }),
};

// The chat return shape from the backend is { content, model, usage }.
export type ChatCompletion = { content: string; model: string; usage: { prompt_tokens: number; completion_tokens: number } };

// ---- Phase 17 — Scaling & Performance ----
export type QueueJob = {
  id: string; queue: string; status: "pending" | "running" | "done" | "failed" | "dead";
  attempts: number; max_attempts: number; run_at: string; last_error: string | null; created_at: string;
};
export type QueueStat = { queue: string; status: string; n: number };
export type RateLimitPolicy = {
  id: string; workspace_id: string | null; route: string;
  scope: "ip" | "user" | "workspace" | "key"; max_hits: number; window_sec: number; action: "block" | "shadow";
};
export const scaling = {
  enqueue: (queue: string, payload: Record<string, unknown>, opts: { run_at?: string; max_attempts?: number } = {}) =>
    api<{ id: string; queue: string; status: string }>(`/queue/v1/${queue}/enqueue`,
      { method: "POST", body: JSON.stringify({ payload, ...opts }) }),
  jobs:  (params: { queue?: string; status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
    return api<{ jobs: QueueJob[]; total: number }>(`/queue/v1/jobs${qs.toString() ? "?" + qs.toString() : ""}`);
  },
  stats: () => api<{ rows: QueueStat[] }>("/queue/v1/stats"),
  cacheGet: (key: string) => api<{ value: unknown; expires_at: string | null }>(`/cache/v1/${encodeURIComponent(key)}`),
  cachePut: (key: string, value: unknown, ttl_sec?: number) =>
    api(`/cache/v1/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value, ttl_sec }) }),
  cacheDel: (key: string) => api(`/cache/v1/${encodeURIComponent(key)}`, { method: "DELETE" }),
  listRateLimits: () => api<{ policies: RateLimitPolicy[] }>("/admin/v1/rate-limits", { service: true }),
  upsertRateLimit: (body: Omit<RateLimitPolicy, "id" | "workspace_id">) =>
    api<RateLimitPolicy>("/admin/v1/rate-limits", { method: "POST", service: true, body: JSON.stringify(body) }),
  deleteRateLimit: (id: string) =>
    api(`/admin/v1/rate-limits/${id}`, { method: "DELETE", service: true }),
  testRateLimit: (body: { route: string; scope?: "ip"|"user"|"workspace"|"key"; identity?: string; hits?: number }) =>
    api<{
      route: string; scope: string; identity: string; key: string;
      policy: { max_hits: number; window_sec: number; action: string };
      result: { allowed: boolean; hits: number; max: number; remaining: number; window_sec: number; reset_in_sec: number; blocked: number };
    }>("/admin/v1/rate-limits/test", { method: "POST", service: true, body: JSON.stringify(body) }),
  rateLimitStatus: () => api<{ snapshot: RateLimitBucket[] }>("/admin/v1/rate-limits/status", { service: true }),
  enqueueTest: (echo?: string, delay_sec = 0) =>
    api<{ id: string; queue: string; run_at: string; status: string }>(
      "/queue/v1/test", { method: "POST", body: JSON.stringify({ ...(echo ? { echo } : {}), delay_sec }) }),
};
export type RateLimitBucket = {
  key: string; hits: number; max: number; remaining: number;
  window_sec: number; reset_in_sec: number; blocked: number;
};

// ---- Phase 18 — Observability & Compliance ----
export type MetricPoint = { bucket: string; v: number };
export type TraceSpan = {
  span_id: string; trace_id: string; parent_id: string | null;
  name: string; kind: string; started_at: string; ended_at: string | null; duration_ms: number | null;
};
export type TraceSummary = {
  trace_id: string; started_at: string; ended_at: string | null;
  total_ms: number; spans: number; root_name: string; root_status: string | null;
};
export type GdprRequest = {
  id: string; subject_id: string; kind: "export" | "erasure";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  requested_at: string; completed_at: string | null; artifact_key: string | null; notes: string | null;
};
export const observability = {
  ingestMetrics: (samples: Array<{ metric: string; value: number; labels?: Record<string, string>; observed_at?: string }>) =>
    api<{ inserted: number }>("/obs/v1/metrics", { method: "POST", body: JSON.stringify({ samples }) }),
  queryMetric: (metric: string, agg: "avg" | "sum" | "count" | "min" | "max" | "p95" = "avg", window_min = 60) => {
    const qs = new URLSearchParams({ metric, agg, window_min: String(window_min) });
    return api<{ metric: string; agg: string; points: MetricPoint[] }>(`/obs/v1/metrics/query?${qs}`);
  },
  ingestSpans: (spans: Array<Partial<TraceSpan> & { trace_id: string; name: string; started_at: string }>) =>
    api<{ inserted: number }>("/obs/v1/spans", { method: "POST", body: JSON.stringify({ spans }) }),
  trace: (traceId: string) => api<{ trace_id: string; spans: TraceSpan[] }>(`/obs/v1/traces/${traceId}`),
  traces: (limit = 25) => api<{ traces: TraceSummary[] }>(`/obs/v1/traces?limit=${limit}`),
  prometheus: () => api<{ body: string }>("/obs/v1/prometheus"),
  metricsText: async (): Promise<string> => {
    const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
    const r = await fetch(cfg.url.replace(/\/$/, "") + "/metrics");
    if (!r.ok) throw new Error(`metrics ${r.status}`);
    return r.text();
  },
  gdprList: () => api<{ requests: GdprRequest[] }>("/compliance/v1/gdpr"),
  gdprCreate: (subject_id: string, kind: "export" | "erasure", notes?: string) =>
    api<{ id: string; status: string }>("/compliance/v1/gdpr",
      { method: "POST", body: JSON.stringify({ subject_id, kind, notes }) }),
  gdprRun: (id: string) => api<{ ok: boolean }>(`/compliance/v1/gdpr/${id}/run`, { method: "POST", service: true }),
};

