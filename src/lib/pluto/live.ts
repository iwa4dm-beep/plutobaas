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
  status?: "ok" | "error" | "dry_run";
  q?: string;
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
      if (params.action) qs.set("action", params.action);
      if (params.actor)  qs.set("actor",  params.actor);
      if (params.status) qs.set("status", params.status);
      if (params.q)      qs.set("q",      params.q);
      if (params.since)  qs.set("since",  params.since);
      if (params.until)  qs.set("until",  params.until);
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
    introspect: () => api<{ tables: SchemaTable[] }>("/admin/v1/schema/", { service: true }),
    summary:    () => api<SchemaSummary>("/admin/v1/schema/summary"),
    openapi:    () => api<Record<string, unknown>>("/admin/v1/schema/openapi.json"),
  },
};

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
