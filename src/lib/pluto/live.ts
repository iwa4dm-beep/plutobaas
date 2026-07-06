// Live-endpoint layer for the Pluto dashboard.
//
// If `VITE_PLUTO_URL` and `VITE_PLUTO_ANON_KEY` are set, we talk to a
// real Pluto backend (REST / auth / storage / realtime / functions).
// If they are unset, `isLive()` returns false and callers keep using
// the mock client in `client.ts` — so the dashboard works with no
// backend configured.

export type LiveConfig = {
  url: string;
  upstreamUrl: string;
  anonKey: string;
  serviceKey?: string;      // optional — only set for admin operations
};

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const DEFAULT_PLUTO_URL = "https://api.timescard.cloud";
const DEFAULT_PLUTO_ANON_KEY = "pk_anon_8439f8cb55a8be5f9559105c55401a4f26ab5667e8364718";
const URL_ = env.VITE_PLUTO_URL ?? DEFAULT_PLUTO_URL;
const ANON_KEY = env.VITE_PLUTO_ANON_KEY ?? DEFAULT_PLUTO_ANON_KEY;
const BROWSER_URL = env.VITE_PLUTO_BROWSER_URL ?? "/api/pluto";

// Service role is optional and only used by admin surfaces (migrations,
// job tokens, edge deploy). Prefer supplying it at runtime via the
// dashboard settings page rather than baking into the bundle.
const SERVICE_KEY = env.VITE_PLUTO_SERVICE_KEY;

export function isLive(): boolean {
  return !!(URL_ && ANON_KEY);
}

export function liveConfig(): LiveConfig | null {
  if (!isLive()) return null;
  return { url: BROWSER_URL!, upstreamUrl: URL_!, anonKey: ANON_KEY!, serviceKey: SERVICE_KEY };
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
    const message = typeof json === "object" && json
      ? String((json as { message?: unknown; error?: unknown }).message ?? (json as { error?: unknown }).error ?? `HTTP ${res.status}`)
      : (typeof json === "string" ? json : `HTTP ${res.status}`);
    throw new Error(message);
  }
  return json as T;
}

function normalizeAuthResponse(r: AuthSession | { user: AuthUser; session: AuthSession }): { user: AuthUser; session: AuthSession } {
  if ("session" in r) return { user: normalizeAuthUser(r.user), session: r.session };
  const session = r as AuthSession;
  const user = session.user;
  if (!user) throw new Error("Auth response did not include a user.");
  return { user: normalizeAuthUser(user), session };
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
      const r = await api<AuthSession | { user: AuthUser; session: AuthSession }>("/auth/v1/signup", {
        method: "POST", body: JSON.stringify({ email, password }),
      });
      const normalized = normalizeAuthResponse(r);
      persistSession(normalized.session, normalized.user);
      const user = await refreshAdminRole();
      return { user: user ?? normalized.user, session: { ...normalized.session, user: user ?? normalized.user } };
    },
    signIn: async (email: string, password: string) => {
      const r = await api<AuthSession | { user: AuthUser; session: AuthSession }>("/auth/v1/token", {
        method: "POST", body: JSON.stringify({ grant_type: "password", email, password }),
      });
      const normalized = normalizeAuthResponse(r);
      persistSession(normalized.session, normalized.user);
      const user = await refreshAdminRole();
      return { user: user ?? normalized.user, session: { ...normalized.session, user: user ?? normalized.user } };
    },
    refresh: async () => {
      const sess = readSession(); if (!sess) throw new Error("no_session");
      const r = await api<AuthSession | { session: AuthSession }>("/auth/v1/token", {
        method: "POST", body: JSON.stringify({ grant_type: "refresh_token", refresh_token: sess.refresh_token }),
      });
      const session = "session" in r ? r.session : r;
      persistSession(session, sess.user as AuthUser);
      return session;
    },
    signOut: async () => {
      try { await api("/auth/v1/logout", { method: "POST" }); } catch { /* clear anyway */ }
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

    // ---- Phase 31 — Auth completion ----
    /** Retrieve public auth config (which flows are enabled server-side). */
    config: () => api<{
      require_email_confirmation: boolean; sms_otp_enabled: boolean;
      email_provider: string; sms_provider: string;
    }>("/auth/v1/settings"),

    /** Send a password-reset email. Always resolves — no user-enumeration. */
    resetPasswordForEmail: (email: string) =>
      api<{ ok: true }>("/auth/v1/recover", { method: "POST", body: JSON.stringify({ email }) }),

    /** Consume a reset token and set a new password. Returns a fresh session. */
    verifyPasswordRecovery: async (token: string, new_password: string) => {
      const r = await api<{ ok: true; session: AuthSession & { user: AuthUser } }>(
        `/auth/v1/verify?${new URLSearchParams({ token, type: "recovery" }).toString()}`,
      );
      persistSession(r.session, r.session.user);
      await api<AuthUser>("/auth/v1/user", { method: "PUT", body: JSON.stringify({ password: new_password }) });
      return r;
    },

    /** Send an email-confirmation link to the currently signed-in user. */
    sendEmailConfirmation: () =>
      api<{ ok: true; already_confirmed?: boolean }>("/auth/v1/send-email-confirmation", { method: "POST" }),

    /** Consume an email-confirmation token from the link the user clicked. */
    confirmEmail: (token: string) =>
      api<{ ok: true }>(`/auth/v1/verify?${new URLSearchParams({ token, type: "signup" }).toString()}`),

    /** Anonymous resend (rate-limited server-side to one every 60s). */
    resendConfirmation: (email: string) =>
      api<{ ok: true }>("/auth/v1/resend-confirmation", { method: "POST", body: JSON.stringify({ email }) }),

    /** Request a 6-digit SMS OTP. `channel` may be "sms" or "whatsapp". */
    signInWithOtp: (input: { phone: string; channel?: "sms" | "whatsapp" }) =>
      api<{ ok: true; ttl_sec: number }>("/auth/v1/otp/send",
        { method: "POST", body: JSON.stringify({ phone: input.phone, channel: input.channel ?? "sms" }) }),

    /** Verify an OTP code; persists the returned session. */
    verifyOtp: async (input: { phone: string; token: string }) => {
      const r = await api<{ session: AuthSession & { user: AuthUser } }>("/auth/v1/otp/verify",
        { method: "POST", body: JSON.stringify({ phone: input.phone, code: input.token }) });
      persistSession(r.session, r.session.user);
      return r;
    },

    /** Send a passwordless email magic link. Server returns `{ ok, ttl_sec }`; in dev also `{ token }`. */
    signInWithMagicLink: (email: string, redirect_to?: string) =>
      api<{ ok: true; ttl_sec: number; token?: string }>("/auth/v1/magiclink/send", {
        method: "POST", body: JSON.stringify({ email, ...(redirect_to ? { redirect_to } : {}) }),
      }),

    /** Consume a magic-link token; persists the resulting session. */
    verifyMagicLink: async (token: string) => {
      const r = await api<{ user: AuthUser; session: AuthSession }>("/auth/v1/magiclink/verify", {
        method: "POST", body: JSON.stringify({ token }),
      });
      persistSession(r.session, r.user);
      return r;
    },
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
    cors: {
      list: () => api<{ items: AllowedOrigin[] }>("/admin/v1/cors/origins", { service: true }),
      add: (origin: string, opts?: { workspace_id?: string | null; note?: string }) =>
        api<{ item: AllowedOrigin }>("/admin/v1/cors/origins", {
          method: "POST", service: true,
          body: JSON.stringify({ origin, ...(opts ?? {}) }),
        }),
      remove: (id: string) =>
        api<{ ok: true }>(`/admin/v1/cors/origins/${id}`, { method: "DELETE", service: true }),
    },
  },
};

export type AllowedOrigin = {
  id: string; workspace_id: string | null;
  origin: string; note: string | null; created_at: string;
};

// ---- Session persistence helpers (used by live.auth.*) ----
function persistSession(s: AuthSession, u: AuthUser): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, user: normalizeAuthUser(u) }));
}

function normalizeAuthUser(u: AuthUser): AuthUser {
  return {
    ...u,
    role: u.is_superadmin || u.role === "admin" ? "admin" : "user",
    email_verified: u.email_verified ?? Boolean(u.email_confirmed_at),
  };
}

// ---- Auth / admin type surface ----
export type AuthUser = { id: string; email: string; role: string; email_verified?: boolean; email_confirmed_at?: string | null; is_superadmin?: boolean; created_at?: string };
export type AuthSession = { access_token: string; refresh_token: string; expires_at: number; user?: AuthUser };
export type AdminUser = AuthUser & { created_at: string; is_superadmin?: boolean };
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

// ---------------- Phase 19 — Developer Experience -----------------------
export type ProjectTemplate = { id: string; slug: string; name: string; description: string; category: string; published: boolean; created_at: string };
export type PersonalToken = { id: string; name: string; scopes: string[]; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; created_at: string };
export type WebhookSub = { id: string; target_url: string; event_types: string[]; active: boolean; failure_count: number; created_at: string };
export type WebhookDelivery = { id: number; event_type: string; status_code: number | null; response_ms: number | null; error: string | null; attempted_at: string; payload?: unknown; headers?: Record<string, string> };
export const DEVEX_TOKEN_SCOPES = ["read", "write", "admin", "storage:read", "storage:write", "functions:invoke", "realtime:subscribe"] as const;
export type DevexTokenScope = typeof DEVEX_TOKEN_SCOPES[number];
export type InstalledPlugin = { id: string; plugin_slug: string; version: string; config: Record<string, unknown>; enabled: boolean; installed_at: string };

export const devex = {
  templates: () => api<{ templates: ProjectTemplate[] }>("/devex/v1/templates"),
  publishTemplate: (t: Partial<ProjectTemplate> & { slug: string; name: string }) =>
    api<ProjectTemplate>("/devex/v1/templates", { method: "POST", service: true, body: JSON.stringify(t) }),
  tokens: () => api<{ tokens: PersonalToken[] }>("/devex/v1/tokens"),
  mintToken: (body: { name: string; scopes?: DevexTokenScope[] | string[]; expires_in_days?: number | null; workspace_id?: string }) =>
    api<{ token: string; meta: PersonalToken; warning: string }>("/devex/v1/tokens", { method: "POST", body: JSON.stringify(body) }),
  revokeToken: (id: string) => api<{ ok: boolean }>(`/devex/v1/tokens/${id}/revoke`, { method: "POST" }),
  webhooks: () => api<{ subscriptions: WebhookSub[] }>("/devex/v1/webhooks"),
  createWebhook: (body: { target_url: string; event_types?: string[] }) =>
    api<WebhookSub & { secret: string; note: string }>("/devex/v1/webhooks", { method: "POST", body: JSON.stringify(body) }),
  deleteWebhook: (id: string) => api<{ ok: boolean }>(`/devex/v1/webhooks/${id}`, { method: "DELETE" }),
  testWebhook: (id: string) => api<{ status_code: number | null; response_ms: number; error: string | null }>(`/devex/v1/webhooks/${id}/test`, { method: "POST" }),
  deliveries: (id: string) => api<{ deliveries: WebhookDelivery[] }>(`/devex/v1/webhooks/${id}/deliveries`),
  replayDelivery: (hookId: string, deliveryId: number) =>
    api<{ status_code: number | null; response_ms: number; error: string | null; replayed: true }>(
      `/devex/v1/webhooks/${hookId}/deliveries/${deliveryId}/replay`,
      { method: "POST" },
    ),
  plugins: () => api<{ installed: InstalledPlugin[] }>("/devex/v1/plugins"),
  installPlugin: (body: { plugin_slug: string; version: string; config?: Record<string, unknown>; enabled?: boolean }) =>
    api<InstalledPlugin>("/devex/v1/plugins", { method: "POST", body: JSON.stringify(body) }),
};

// ---------------- Phase 20 — Enterprise & Multi-region ------------------
export type IpRule = { id: string; cidr: string; action: "allow" | "deny"; note: string | null; created_at: string };
export type CustomDomain = { id: string; hostname: string; verified: boolean; verify_token: string; cert_status: string; created_at: string; verified_at: string | null };
export type RegionConfig = { primary_region: string; read_regions: string[]; pin_writes: boolean; updated_at?: string };
export type StatusComponent = { id: string; name: string; status: string; updated_at: string };
export type StatusIncident = { id: string; title: string; body: string; severity: string; component_id: string | null; started_at: string; resolved_at: string | null };

export const enterprise = {
  ipRules: () => api<{ rules: IpRule[] }>("/enterprise/v1/ip-rules"),
  addIpRule: (body: { cidr: string; action: "allow" | "deny"; note?: string }) =>
    api<IpRule>("/enterprise/v1/ip-rules", { method: "POST", body: JSON.stringify(body) }),
  removeIpRule: (id: string) => api<{ ok: boolean }>(`/enterprise/v1/ip-rules/${id}`, { method: "DELETE" }),
  checkIp: (workspace_id: string, ip: string) =>
    api<{ decision: "allow" | "deny"; matched: number; has_allow_list: boolean; matched_rules?: IpRule[]; reason?: string }>(
      "/enterprise/v1/ip-rules/check",
      { method: "POST", body: JSON.stringify({ workspace_id, ip }) }),
  domains: () => api<{ domains: CustomDomain[] }>("/enterprise/v1/domains"),
  addDomain: (hostname: string) =>
    api<CustomDomain & { dns_txt_record: string; dns_txt_value: string }>("/enterprise/v1/domains",
      { method: "POST", body: JSON.stringify({ hostname }) }),
  verifyDomain: (id: string) => api<{ ok: boolean; verified: boolean }>(`/enterprise/v1/domains/${id}/verify`, { method: "POST" }),
  removeDomain: (id: string) => api<{ ok: boolean }>(`/enterprise/v1/domains/${id}`, { method: "DELETE" }),
  regions: () => api<RegionConfig>("/enterprise/v1/regions"),
  updateRegions: (body: RegionConfig) => api<RegionConfig>("/enterprise/v1/regions", { method: "PUT", body: JSON.stringify(body) }),
  status: () => api<{ overall: string; components: StatusComponent[]; incidents: StatusIncident[] }>("/enterprise/v1/status"),
  postIncident: (body: { title: string; body?: string; severity?: string; component_id?: string; resolved?: boolean }) =>
    api<StatusIncident>("/enterprise/v1/status/incidents", { method: "POST", service: true, body: JSON.stringify(body) }),
};



// ---------------- Phase 21 — Branching, Studio, Metered Usage ----------------
export type DbBranch = { id: string; name: string; schema_name: string; parent_id: string | null; status: string; created_at: string };
export type BranchChange = { id: number; statement: string; ok: boolean; error: string | null; applied_at: string };
export type SchemaOp =
  | { op: "create_table"; schema?: string; table: string; columns: Array<{ name: string; type: string; nullable?: boolean; default?: string; primary?: boolean }> }
  | { op: "add_column"; schema?: string; table: string; column: string; type: string; nullable?: boolean; default?: string }
  | { op: "drop_column"; schema?: string; table: string; column: string }
  | { op: "add_index"; schema?: string; table: string; name: string; columns: string[]; unique?: boolean }
  | { op: "add_fk"; schema?: string; table: string; name: string; column: string; ref_table: string; ref_column: string };
export type UsageMetric = "storage_gb" | "egress_gb" | "function_invocations" | "ai_tokens" | "db_rows" | "realtime_msgs";
export type OverageBehavior = "allow" | "warn" | "block";
export type UsageEnvironment = "production" | "staging" | "preview" | "development";
export type UsageMetricSummary = {
  used: number; hard_limit: number | null; soft_limit: number | null; pct: number | null;
  overage_behavior: OverageBehavior | null; billing_label: string | null;
  by_env: Record<string, number>; by_label: Record<string, number>;
};
export type UsageSummary = { period: string; environment: string | null; metrics: Record<UsageMetric, UsageMetricSummary> };
export type Quota = {
  metric: UsageMetric; period: "day" | "month"; hard_limit: number; soft_limit: number | null;
  overage_behavior: OverageBehavior; billing_label: string | null; updated_at: string;
  alert_pct?: number | null;
};
export type BranchSnapshot = { id: string; snapshot_schema: string; reason: string | null; created_at: string; restored_at: string | null; status: string };

export const branching = {
  list: () => api<{ branches: DbBranch[] }>("/branches/v1"),
  create: (body: { name: string; parent_id?: string; copy_from?: string }) =>
    api<DbBranch>("/branches/v1", { method: "POST", body: JSON.stringify(body) }),
  remove: (id: string) => api<{ ok: boolean }>(`/branches/v1/${id}`, { method: "DELETE" }),
  apply: (id: string, sql: string) =>
    api<{ ok: boolean; error?: string }>(`/branches/v1/${id}/apply`, { method: "POST", body: JSON.stringify({ sql }) }),
  changes: (id: string) => api<{ changes: BranchChange[] }>(`/branches/v1/${id}/changes`),
  snapshots: (id: string) => api<{ snapshots: BranchSnapshot[] }>(`/branches/v1/${id}/snapshots`),
  createSnapshot: (id: string, reason?: string) =>
    api<BranchSnapshot>(`/branches/v1/${id}/snapshots`, { method: "POST", body: JSON.stringify({ reason }) }),
  restoreSnapshot: (id: string, snapId: string) =>
    api<{ ok: boolean }>(`/branches/v1/${id}/snapshots/${snapId}/restore`, { method: "POST" }),
  deleteSnapshot: (id: string, snapId: string) =>
    api<{ ok: boolean }>(`/branches/v1/${id}/snapshots/${snapId}`, { method: "DELETE" }),
};

export const studio = {
  apply: (operations: SchemaOp[], opts?: { branch_id?: string; dry_run?: boolean }) =>
    api<{ ok?: boolean; dry_run?: boolean; statements?: Array<{ sql: string }>; results?: Array<{ sql: string; ok: boolean; error?: string }> }>(
      "/schema/v1/apply",
      { method: "POST", body: JSON.stringify({ operations, ...(opts ?? {}) }) }),
  history: () => api<{ edits: Array<{ id: number; operation: SchemaOp; sql: string; ok: boolean; error: string | null; applied_at: string; branch_id: string | null }> }>("/schema/v1/history"),
};

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer" | "global_admin" | "service_role" | "anon";

export const me = {
  workspaceRole: () => api<{ role: WorkspaceRole; can_admin: boolean }>("/me/v1/workspace-role"),
};

export const usage = {
  record: (body: { metric: UsageMetric; quantity: number; environment?: UsageEnvironment; billing_label?: string; meta?: Record<string, unknown> }) =>
    api<{ ok: boolean }>("/usage/v1/events", { method: "POST", body: JSON.stringify(body) }),
  summary: (period: "day" | "month" = "month", environment?: UsageEnvironment) =>
    api<UsageSummary>(`/usage/v1/summary?period=${period}${environment ? `&environment=${environment}` : ""}`),
  quotas: () => api<{ quotas: Quota[] }>("/usage/v1/quotas"),
  setQuota: (body: { metric: UsageMetric; period?: "day" | "month"; hard_limit: number; soft_limit?: number; overage_behavior?: OverageBehavior; billing_label?: string; alert_pct?: number }) =>
    api<{ ok: boolean }>("/usage/v1/quotas", { method: "PUT", body: JSON.stringify(body) }),

  // Phase 22b — Server-Sent Events stream. Fetch-based (EventSource can't
  // send auth headers). Returns an unsubscribe function; the callback fires
  // once on connect and again on every ingest / 3s heartbeat.
  stream(
    onSummary: (s: UsageSummary & { quotas: Quota[]; ts: number }) => void,
    opts: { period?: "day" | "month"; environment?: UsageEnvironment; onError?: (e: Error) => void } = {},
  ): () => void {
    const cfg = liveConfig();
    if (!cfg) { opts.onError?.(new Error("Pluto backend not configured")); return () => undefined; }
    const controller = new AbortController();
    const qs = new URLSearchParams();
    if (opts.period) qs.set("period", opts.period);
    if (opts.environment) qs.set("environment", opts.environment);
    (async () => {
      try {
        const res = await fetch(`${cfg.url.replace(/\/$/, "")}/usage/v1/stream?${qs.toString()}`, {
          method: "GET",
          headers: { ...bearer(false), accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream failed: HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const lines = raw.split("\n");
            let event = "message"; let data = "";
            for (const l of lines) {
              if (l.startsWith("event:")) event = l.slice(6).trim();
              else if (l.startsWith("data:")) data += l.slice(5).trim();
            }
            if (event === "summary" && data) {
              try { onSummary(JSON.parse(data)); } catch { /* malformed frame */ }
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") opts.onError?.(e as Error);
      }
    })();
    return () => controller.abort();
  },

  alerts: (unresolved = true) =>
    api<{ alerts: QuotaAlert[] }>(`/usage/v1/alerts${unresolved ? "?unresolved=1" : ""}`),
  resolveAlert: (id: string) =>
    api<{ ok: boolean }>(`/usage/v1/alerts/${id}/resolve`, { method: "POST" }),
  webhooks: () => api<{ webhooks: UsageWebhook[] }>("/usage/v1/webhooks"),
  createWebhook: (body: { url: string; secret?: string; events?: string[] }) =>
    api<{ webhook: UsageWebhook }>("/usage/v1/webhooks", { method: "POST", body: JSON.stringify(body) }),
  deleteWebhook: (id: string) =>
    api<{ ok: boolean }>(`/usage/v1/webhooks/${id}`, { method: "DELETE" }),

  // Phase 29 — webhook delivery attempts + on-demand redelivery.
  deliveries: (webhookId: string, params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit)  qs.set("limit",  String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return api<{ deliveries: UsageWebhookDelivery[] }>(
      `/usage/v1/webhooks/${webhookId}/deliveries${qs.size ? `?${qs}` : ""}`);
  },
  redeliver: (webhookId: string, deliveryId: string) =>
    api<{ ok: boolean }>(`/usage/v1/webhooks/${webhookId}/redeliver/${deliveryId}`, { method: "POST" }),

  // Phase 29 — quota-alert SSE (replaces the 15s polling banner refresh).
  // Fires "quota.alert" events for the caller's workspace as they happen,
  // plus a snapshot of currently-unresolved alerts on connect.
  streamAlerts(opts: { onEvent: (payload: AlertEventPayload) => void; onError?: (e: Error) => void }): () => void {
    const controller = new AbortController();
    (async () => {
      try {
        const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
        const res = await fetch(cfg.url.replace(/\/$/, "") + `/usage/v1/alerts/stream`, {
          signal: controller.signal, headers: { accept: "text/event-stream", ...bearer(false) },
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
          for (const p of parts) {
            const dataLine = p.split("\n").find(l => l.startsWith("data: "));
            if (!dataLine) continue;
            try { opts.onEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
          }
        }
      } catch (e) { if ((e as Error).name !== "AbortError") opts.onError?.(e as Error); }
    })();
    return () => controller.abort();
  },
};

export type QuotaAlert = { id: string; metric: UsageMetric; pct: number; used: number; hard_limit: number | null; triggered_at: string; notified: boolean; resolved_at: string | null };
export type UsageWebhook = { id: string; url: string; events: string[]; active: boolean; last_status: number | null; last_error: string | null; last_delivered_at: string | null; created_at: string };
export type UsageWebhookDelivery = {
  id: string; webhook_id: string; alert_id: string | null; event: string;
  attempt: number; status_code: number | null; response_time_ms: number | null;
  error: string | null; delivered_at: string; next_retry_at: string | null;
  succeeded: boolean; payload_hash: string;
};
export type AlertEventPayload = {
  type: "quota.alert"; workspace_id: string; alert_id: string;
  metric: UsageMetric; pct: number; used: number; hard_limit: number | null; triggered_at: string;
};

// -------------------- Phase 23: Realtime v2 --------------------
export type Rt2Channel = { id: string; name: string; kind: "broadcast"|"presence"; created_at: string; members?: number };
export type Rt2Message = { id: number; event: string; payload: Record<string, unknown>; sender: string|null; created_at: string };
export type Rt2Member  = { member_key: string; metadata: Record<string, unknown>; last_seen: string };

export const rt2 = {
  channels:      ()                                                       => api<{ channels: Rt2Channel[] }>("/rt2/v1/channels"),
  createChannel: (name: string, kind: "broadcast"|"presence" = "broadcast") =>
    api<{ channel: Rt2Channel }>("/rt2/v1/channels", { method: "POST", body: JSON.stringify({ name, kind }) }),
  messages:      (name: string, limit = 50) =>
    api<{ messages: Rt2Message[] }>(`/rt2/v1/channels/${encodeURIComponent(name)}/messages?limit=${limit}`),
  broadcast:     (name: string, event: string, payload: Record<string, unknown>, sender?: string) =>
    api<{ ok: boolean; id: number }>(`/rt2/v1/channels/${encodeURIComponent(name)}/broadcast`,
      { method: "POST", body: JSON.stringify({ event, payload, sender }) }),
  presence:      (name: string) =>
    api<{ members: Rt2Member[] }>(`/rt2/v1/channels/${encodeURIComponent(name)}/presence`),
  join:          (name: string, member_key: string, metadata: Record<string, unknown> = {}) =>
    api<{ ok: boolean }>(`/rt2/v1/channels/${encodeURIComponent(name)}/presence`,
      { method: "POST", body: JSON.stringify({ member_key, metadata }) }),
  leave:         (name: string, member_key: string) =>
    api<{ ok: boolean }>(`/rt2/v1/channels/${encodeURIComponent(name)}/presence/${encodeURIComponent(member_key)}`,
      { method: "DELETE" }),
  /**
   * Presence subscription with heartbeat + auto-resubscribe on failure.
   * - Sends join() every `heartbeatMs` (default 20s) so the member row stays fresh.
   * - Polls presence roster every `pollMs` (default 3s).
   * - On any failure, retries with jittered exponential backoff (capped at `maxBackoffMs`, default 30s).
   * - Gives up after `maxAttempts` consecutive failures (default 8) and emits `onStatus("failed")`.
   * - `onStatus(state, attempt, lastError)` fires on every state change: connecting, live, retrying, failed.
   * Returns an unsubscribe function.
   */
  subscribePresence(name: string, member_key: string, opts: {
    metadata?: Record<string, unknown>;
    heartbeatMs?: number;
    pollMs?: number;
    maxAttempts?: number;
    maxBackoffMs?: number;
    onMembers?: (m: Rt2Member[]) => void;
    onReconnect?: (attempt: number) => void;
    onError?: (err: Error) => void;
    onStatus?: (state: "connecting" | "live" | "retrying" | "failed", attempt: number, lastError?: Error) => void;
  } = {}) {
    const heartbeatMs = opts.heartbeatMs ?? 20_000;
    const pollMs = opts.pollMs ?? 3_000;
    const maxAttempts = opts.maxAttempts ?? 8;
    const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    let stopped = false; let attempt = 0;
    let hbTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const clearTimers = () => {
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
    // Jittered exponential backoff — full-jitter variant to spread reconnects.
    const backoff = () => {
      const base = Math.min(maxBackoffMs, 500 * 2 ** attempt);
      return Math.floor(Math.random() * base);
    };

    opts.onStatus?.("connecting", 0);

    const start = async () => {
      while (!stopped) {
        try {
          await rt2.join(name, member_key, opts.metadata ?? {});
          const wasRetrying = attempt > 0;
          if (wasRetrying) opts.onReconnect?.(attempt);
          attempt = 0;
          opts.onStatus?.("live", 0);
          hbTimer = setInterval(() => {
            rt2.join(name, member_key, opts.metadata ?? {}).catch((e) => opts.onError?.(e as Error));
          }, heartbeatMs);
          pollTimer = setInterval(async () => {
            try { const r = await rt2.presence(name); opts.onMembers?.(r.members); }
            catch (e) { opts.onError?.(e as Error); }
          }, pollMs);
          await new Promise<void>((resolve) => {
            const iv = setInterval(() => { if (stopped) { clearInterval(iv); resolve(); } }, 250);
          });
          return;
        } catch (e) {
          clearTimers();
          const err = e as Error;
          opts.onError?.(err);
          attempt++;
          if (attempt >= maxAttempts) { opts.onStatus?.("failed", attempt, err); return; }
          opts.onStatus?.("retrying", attempt, err);
          await new Promise(r => setTimeout(r, backoff()));
        }
      }
    };

    void start();

    return () => {
      stopped = true;
      clearTimers();
      rt2.leave(name, member_key).catch(() => { /* best effort */ });
    };
  },
};

// -------------------- Phase 23: Vector search --------------------
export type VecCollection = { id: string; name: string; dims: number; docs: number; created_at: string };
export type VecMatch      = { id: string; external_id: string|null; content: string; metadata: Record<string, unknown>; score: number };

export const vector = {
  collections:      ()                                     => api<{ collections: VecCollection[] }>("/vec/v1/collections"),
  createCollection: (name: string, dims = 1536)            =>
    api<{ collection: VecCollection }>("/vec/v1/collections", { method: "POST", body: JSON.stringify({ name, dims }) }),
  docs:             (name: string) =>
    api<{ docs: { id: string; external_id: string|null; content: string; metadata: Record<string, unknown>; created_at: string }[] }>(
      `/vec/v1/collections/${encodeURIComponent(name)}/docs`),
  upsert:           (name: string, docs: { id?: string; external_id?: string; content: string; embedding: number[]; metadata?: Record<string, unknown> }[]) =>
    api<{ ok: boolean; inserted: number }>(`/vec/v1/collections/${encodeURIComponent(name)}/upsert`,
      { method: "POST", body: JSON.stringify({ docs }) }),
  query:            (name: string, embedding: number[], top_k = 5, embedding_field?: string) =>
    api<{ matches: VecMatch[] }>(`/vec/v1/collections/${encodeURIComponent(name)}/query`,
      { method: "POST", body: JSON.stringify({ embedding, top_k, embedding_field }) }),
};

// -------------------- Phase 24: Edge Functions v2 --------------------
export type FnSecret   = { id: string; function_slug: string; name: string; created_at: string };
export type FnSchedule = { id: string; function_slug: string; cron: string; active: boolean; last_run_at: string|null; next_run_at: string|null; created_at: string };
export type FnInvocation = { id: number; function_slug: string; trigger: "http"|"cron"|"manual"; status_code: number|null; duration_ms: number|null; cold_start: boolean; error: string|null; created_at: string };

export const edgeV2 = {
  secrets:       (slug?: string) => api<{ secrets: FnSecret[] }>(`/fn/v2/secrets${slug ? `?slug=${encodeURIComponent(slug)}` : ""}`),
  setSecret:     (function_slug: string, name: string, value: string) =>
    api<{ secret: FnSecret }>("/fn/v2/secrets", { method: "POST", body: JSON.stringify({ function_slug, name, value }) }),
  deleteSecret:  (id: string) => api<{ ok: boolean }>(`/fn/v2/secrets/${id}`, { method: "DELETE" }),
  schedules:     () => api<{ schedules: FnSchedule[] }>("/fn/v2/schedules"),
  createSchedule:(function_slug: string, cron: string, active = true) =>
    api<{ schedule: FnSchedule }>("/fn/v2/schedules", { method: "POST", body: JSON.stringify({ function_slug, cron, active }) }),
  toggleSchedule:(id: string, active: boolean) =>
    api<{ schedule: FnSchedule }>(`/fn/v2/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }),
  deleteSchedule:(id: string) => api<{ ok: boolean }>(`/fn/v2/schedules/${id}`, { method: "DELETE" }),
  invocations:   (slug?: string, limit = 100) =>
    api<{ invocations: FnInvocation[] }>(`/fn/v2/invocations?limit=${limit}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}`),
  logInvocation: (body: { function_slug: string; trigger?: "http"|"cron"|"manual"; status_code?: number; duration_ms?: number; cold_start?: boolean; error?: string }) =>
    api<{ ok: boolean; id: number }>("/fn/v2/invocations", { method: "POST", body: JSON.stringify(body) }),
  // Functions catalog (Phase 25).
  functions:      () => api<{ functions: FnCatalog[] }>("/fn/v2/functions"),
  upsertFunction: (body: { slug: string; display_name?: string; runtime?: "node20"|"deno1"|"bun1"; entry?: string; active?: boolean }) =>
    api<{ function: FnCatalog }>("/fn/v2/functions", { method: "POST", body: JSON.stringify(body) }),
  deleteFunction: (slug: string) => api<{ ok: boolean }>(`/fn/v2/functions/${encodeURIComponent(slug)}`, { method: "DELETE" }),
  invoke:         (slug: string, payload: Record<string, unknown> = {}, simulate_error = false) =>
    api<{ ok: boolean; status_code: number; duration_ms: number; echoed: Record<string, unknown>; error: { message: string; type?: string; stack?: string } | null }>(
      `/fn/v2/functions/${encodeURIComponent(slug)}/invoke`,
      { method: "POST", body: JSON.stringify({ payload, simulate_error }) }),
};

export type FnCatalog = { id: string; slug: string; display_name: string|null; runtime: string; entry: string; active: boolean; created_at: string; updated_at: string; schedules: number; secrets: number; invocations_24h: number };

// -------------------- Phase 24: Backups --------------------
export type BackupExport = { id: string; kind: "full"|"schema"|"table"; target: string|null; status: "pending"|"running"|"done"|"failed"; bytes: number; download_path: string|null; error: string|null; created_at: string; finished_at: string|null };
export type BackupRestore = { id: string; export_id?: string; dry_run: boolean; status: "pending"|"running"|"done"|"failed"|"canceled"; progress: number; applied_statements: number; total_statements: number; log?: string; error: string|null; created_at: string; finished_at: string|null };
export type BackupColumnDiff = {
  table: string; column: string;
  source_type: string | null; target_type: string | null;
  nullable_change?: string;
  action: "add" | "drop" | "retype" | "nullable";
};
export type BackupCompat = {
  target_schema: string;
  source_tables: number; target_tables: number;
  added_tables: string[]; removed_tables: string[];
  columns: BackupColumnDiff[];
  compatible: boolean;
};

export const backups = {
  list:   ()                                                     => api<{ exports: BackupExport[] }>("/backups/v1"),
  start:  (kind: "full"|"schema"|"table" = "full", target?: string) =>
    api<{ export: BackupExport }>("/backups/v1", { method: "POST", body: JSON.stringify({ kind, target }) }),
  get:    (id: string) => api<{ export: BackupExport }>(`/backups/v1/${id}`),
  cancel: (id: string) => api<{ ok: boolean }>(`/backups/v1/${id}/cancel`, { method: "POST" }),
  // Phase 30 — schema compatibility diff for the restore wizard.
  compat: (exportId: string, params: { target_branch_id?: string; target_schema?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.target_branch_id) qs.set("target_branch_id", params.target_branch_id);
    if (params.target_schema)    qs.set("target_schema",    params.target_schema);
    return api<BackupCompat>(`/backups/v1/${exportId}/compat${qs.size ? `?${qs}` : ""}`);
  },
  // Restore workflow (Phase 25) — dry_run by default, requires confirm='RESTORE' for live.
  restores: (exportId: string) => api<{ restores: BackupRestore[] }>(`/backups/v1/${exportId}/restores`),
  startRestore: (exportId: string, opts: { dry_run?: boolean; confirm?: string; target_branch_id?: string; create_branch?: string; allow_incompatible?: boolean } = {}) =>
    api<{ restore: BackupRestore & { target_branch_id?: string | null; target_schema?: string | null } }>(`/backups/v1/${exportId}/restore`,
      { method: "POST", body: JSON.stringify({ dry_run: opts.dry_run ?? true, confirm: opts.confirm,
        target_branch_id: opts.target_branch_id, create_branch: opts.create_branch, allow_incompatible: opts.allow_incompatible }) }),
  restoreStatus: (rid: string) => api<{ restore: BackupRestore }>(`/backups/v1/restores/${rid}`),
  cancelRestore: (rid: string) => api<{ ok: boolean }>(`/backups/v1/restores/${rid}/cancel`, { method: "POST" }),
  // SSE progress stream: yields BackupRestore rows until status is terminal.
  streamRestore(rid: string, opts: { onEvent: (r: BackupRestore) => void; onError?: (e: Error) => void }): () => void {
    const controller = new AbortController();
    (async () => {
      try {
        const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
        const res = await fetch(cfg.url.replace(/\/$/, "") + `/backups/v1/restores/${rid}/stream`, {
          signal: controller.signal, headers: { accept: "text/event-stream", ...bearer(false) },
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
          for (const p of parts) {
            const line = p.split("\n").find(l => l.startsWith("data: "));
            if (!line) continue;
            try { opts.onEvent(JSON.parse(line.slice(6)) as BackupRestore); } catch { /* ignore */ }
          }
        }
      } catch (e) { if ((e as Error).name !== "AbortError") opts.onError?.(e as Error); }
    })();
    return () => controller.abort();
  },
};

// ============================================================
// Phase 27 — Logs Explorer SDK
// ============================================================
export type LogRow = { id: string; ts: string; source: string; level: string; message: string; user_id: string | null };
export type LogSearch = {
  source?: string; level?: string; q?: string; since?: string; until?: string; limit?: number; offset?: number;
};

export const logsV2 = {
  async search(p: LogSearch = {}): Promise<{ logs: LogRow[] }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v != null && v !== "") qs.set(k, String(v));
    return api(`/logs/v1/search?${qs.toString()}`);
  },
  async facets(): Promise<{ by_source: Array<{ source: string; n: string }>; by_level: Array<{ level: string; n: string }> }> {
    return api(`/logs/v1/facets`);
  },
  async retention(): Promise<{ keep_days: number }> { return api(`/logs/v1/retention`); },
  async setRetention(keep_days: number): Promise<{ ok: true; keep_days: number }> {
    return api(`/logs/v1/retention`, { method: "PUT", body: JSON.stringify({ keep_days }) });
  },
  tail(
    p: { source?: string; level?: string; q?: string; since?: string },
    opts: {
      onRow: (r: LogRow) => void;
      onError?: (e: Error) => void;
      onStatus?: (s: "connecting" | "live" | "retrying" | "failed", attempt?: number, err?: Error) => void;
      maxAttempts?: number;
      maxBackoffMs?: number;
    },
  ): () => void {
    const controller = new AbortController();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v != null && v !== "") qs.set(k, String(v));
    const maxAttempts = opts.maxAttempts ?? 8;
    const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    let lastEventId: string | undefined;
    let attempt = 0;

    const run = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        opts.onStatus?.(attempt === 0 ? "connecting" : "retrying", attempt);
        try {
          const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
          const headers: Record<string, string> = { accept: "text/event-stream", ...bearer(false) };
          if (lastEventId) headers["last-event-id"] = lastEventId;
          const res = await fetch(cfg.url.replace(/\/$/, "") + `/logs/v1/stream?${qs.toString()}`, {
            signal: controller.signal, headers,
          });
          if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
          attempt = 0;
          opts.onStatus?.("live");
          const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
            for (const chunk of parts) {
              const idLine   = chunk.split("\n").find((l) => l.startsWith("id: "));
              const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
              if (idLine) lastEventId = idLine.slice(4).trim();
              if (!dataLine) continue;
              try { opts.onRow(JSON.parse(dataLine.slice(6)) as LogRow); } catch { /* ignore */ }
            }
          }
          // Server closed the stream cleanly — loop to reconnect with resume cursor.
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          attempt += 1;
          if (attempt > maxAttempts) {
            opts.onStatus?.("failed", attempt, e as Error);
            opts.onError?.(e as Error);
            return;
          }
        }
        const base = Math.min(maxBackoffMs, 500 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * base)));
      }
    };
    void run();
    return () => controller.abort();
  },

  // ---- Export jobs -----------------------------------------------
  async startExport(input: {
    format: "csv" | "json"; source?: string; level?: string; q?: string;
    since?: string; until?: string; max_rows?: number;
  }): Promise<{
    job_id: string; status: string; progress: number; format: "csv" | "json";
    since: string; until: string; clamped_since: boolean; keep_days: number;
  }> {
    return api(`/logs/v1/export`, { method: "POST", body: JSON.stringify(input) });
  },
  async getExport(jobId: string): Promise<{
    job_id: string; status: "queued" | "running" | "done" | "error";
    progress: number; rows: number; format: "csv" | "json";
    error: string | null; download_url: string | null;
  }> {
    return api(`/logs/v1/export/${encodeURIComponent(jobId)}`);
  },
  exportDownloadUrl(jobId: string): string {
    const cfg = liveConfig(); if (!cfg) return "";
    return cfg.url.replace(/\/$/, "") + `/logs/v1/export/${encodeURIComponent(jobId)}/download`;
  },
  async downloadExport(jobId: string): Promise<Blob> {
    const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
    const res = await fetch(this.exportDownloadUrl(jobId), { headers: { ...bearer(false) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  },
};


// ============================================================
// Phase 28 — Workspace API tokens SDK
// ============================================================
export type WorkspaceToken = {
  id: string; workspace_id: string; name: string; prefix: string; scopes: string[];
  created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
};
export type WorkspaceTokenMint = WorkspaceToken & { token: string; replaced_id?: string };
export type ScopeCoverageEntry = { method: string; path: string; description: string };
export type ScopeCoverage = Record<string, ScopeCoverageEntry[]>;
export type BulkRevokeInput = {
  scope?: string; created_by?: string; last_used_before?: string;
  never_used?: boolean; include_expired?: boolean; ids?: string[]; dry_run?: boolean;
};
export type BulkRevokeMatch = {
  id: string; name: string; prefix: string; scopes: string[];
  created_by: string | null; last_used_at: string | null; expires_at: string | null;
};
export type BulkRevokeResult = { dry_run: boolean; matched: number; revoked: string[]; tokens: BulkRevokeMatch[] };

export const tokens = {
  async scopes(): Promise<{ scopes: string[] }> { return api(`/tokens/v1/scopes`); },
  async list(): Promise<{ tokens: WorkspaceToken[] }> { return api(`/tokens/v1/tokens`); },
  async create(input: { name: string; scopes: string[]; expires_in_days?: number }): Promise<WorkspaceTokenMint> {
    return api(`/tokens/v1/tokens`, { method: "POST", body: JSON.stringify(input) });
  },
  async revoke(id: string): Promise<{ ok: true }> {
    return api(`/tokens/v1/tokens/${id}`, { method: "DELETE" });
  },
  async rotate(id: string, input: { name?: string; expires_in_days?: number } = {}): Promise<WorkspaceTokenMint> {
    return api(`/tokens/v1/tokens/${id}/rotate`, { method: "POST", body: JSON.stringify(input) });
  },
  async coverage(): Promise<{ coverage: ScopeCoverage }> { return api(`/tokens/v1/coverage`); },
  async bulkRevoke(input: BulkRevokeInput): Promise<BulkRevokeResult> {
    return api(`/tokens/v1/tokens/bulk-revoke`, { method: "POST", body: JSON.stringify(input) });
  },
  async whoami(bearer: string): Promise<{ workspace_id: string | null; scopes: string[] }> {
    const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
    const res = await fetch(cfg.url.replace(/\/$/, "") + `/tokens/v1/whoami`, {
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${bearer}` },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
    return j as { workspace_id: string | null; scopes: string[] };
  },
};


// ============================================================
// Phase 32 — Storage extensions: image transforms + TUS uploads
// ============================================================

export type ImageTransformParams = {
  width?: number; height?: number;
  resize?: "cover" | "contain" | "fill";
  quality?: number;
  format?: "webp" | "jpeg" | "png" | "avif" | "original";
};

export const storageV2 = {
  /**
   * Build a URL to the image-render endpoint. The dashboard uses this to
   * preview transforms without downloading the source client-side.
   */
  renderUrl(bucket: string, key: string, params: ImageTransformParams = {}): string {
    const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const base = cfg.url.replace(/\/$/, "");
    const q = qs.toString();
    return `${base}/storage/v1/render/image/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}${q ? `?${q}` : ""}`;
  },

  async purgeRenderCache(bucket: string): Promise<{ ok: boolean; purged: number }> {
    return api(`/storage/v1/render/cache/${encodeURIComponent(bucket)}`, { method: "DELETE" });
  },

  /**
   * Minimal TUS 1.0.0 client. Streams the file to
   * `/storage/v1/upload/resumable` in `chunkSize`-sized parts, resuming
   * from the server-reported offset on reconnect. Rejects on protocol or
   * HTTP error; resolves with the final object descriptor on completion.
   */
  async uploadResumable(input: {
    bucket: string;
    key: string;
    file: Blob;
    contentType?: string;
    chunkSize?: number;                // default 5 MiB
    onProgress?: (uploaded: number, total: number) => void;
  }): Promise<{ id: string; bucket: string; key: string; size: number }> {
    const cfg = liveConfig(); if (!cfg) throw new Error("Pluto backend not configured");
    const base = cfg.url.replace(/\/$/, "");
    const chunkSize = input.chunkSize ?? 5 * 1024 * 1024;
    const size = input.file.size;
    const meta = [
      ["bucket", input.bucket],
      ["filename", input.key],
      ["contentType", input.contentType ?? input.file.type ?? "application/octet-stream"],
    ].map(([k, v]) => `${k} ${btoa(v)}`).join(",");
    const headers = { ...bearer(), "Tus-Resumable": "1.0.0" };

    const createRes = await fetch(`${base}/storage/v1/upload/resumable`, {
      method: "POST",
      headers: { ...headers, "Upload-Length": String(size), "Upload-Metadata": meta },
    });
    if (createRes.status !== 201) throw new Error(`tus_create_${createRes.status}`);
    const location = createRes.headers.get("Location");
    if (!location) throw new Error("tus_no_location");
    const uploadUrl = location.startsWith("http") ? location : `${base}${location}`;

    let offset = 0;
    while (offset < size) {
      const end = Math.min(offset + chunkSize, size);
      const chunk = input.file.slice(offset, end);
      const patchRes = await fetch(uploadUrl, {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": String(offset),
        },
        body: chunk,
      });
      if (patchRes.status === 409) {
        // Resume from server-reported offset.
        const head = await fetch(uploadUrl, { method: "HEAD", headers });
        offset = Number(head.headers.get("Upload-Offset") ?? offset);
        continue;
      }
      if (patchRes.status !== 204) throw new Error(`tus_patch_${patchRes.status}`);
      offset = Number(patchRes.headers.get("Upload-Offset") ?? end);
      input.onProgress?.(offset, size);
    }

    const id = uploadUrl.split("/").pop() ?? "";
    return { id, bucket: input.bucket, key: input.key, size };
  },
};


// ============================================================
// Phase 33 — Postgres CDC (change data capture) admin + subscribe
// ============================================================

export type CdcTable = {
  schema_name: string; table_name: string; enabled: boolean;
  created_at: string; updated_at: string;
};
export type CdcEventRow = {
  id: number; commit_ts: string; schema_name: string; table_name: string;
  op: "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";
  row_pk: unknown; new_row: unknown; old_row: unknown; lsn: string | null;
};

export const cdc = {
  listTables: () => api<{ tables: CdcTable[] }>("/rt/v2/cdc/tables"),
  enableTable: (schema: string, table: string) =>
    api<{ ok: true }>("/rt/v2/cdc/tables",
      { method: "POST", body: JSON.stringify({ schema, table }) }),
  disableTable: (schema: string, table: string) =>
    api<{ ok: true }>(`/rt/v2/cdc/tables/${encodeURIComponent(schema)}.${encodeURIComponent(table)}`,
      { method: "DELETE" }),
  slotLag: () => api<{ slot: string; lag_bytes: number | null }>("/rt/v2/cdc/slot-lag"),
  events: (params: { schema?: string; table?: string; since_id?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.schema)   qs.set("schema",   params.schema);
    if (params.table)    qs.set("table",    params.table);
    if (params.since_id !== undefined) qs.set("since_id", String(params.since_id));
    if (params.limit)    qs.set("limit",    String(params.limit));
    return api<{ events: CdcEventRow[] }>(`/rt/v2/cdc/events${qs.toString() ? `?${qs}` : ""}`);
  },
  /** Validate a subscription payload before opening a websocket. */
  validateSubscribe: (input: { schema?: string; table: string; filter?: string }) =>
    api<{ ok: true; channel: string; filter: unknown }>("/rt/v2/cdc/subscribe", {
      method: "POST",
      body: JSON.stringify({ event: "postgres_changes", schema: input.schema ?? "public",
                              table: input.table, filter: input.filter }),
    }),
};
