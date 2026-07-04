// @pluto/client — minimal typed SDK skeleton targeting canonical endpoints.
// Uses only fetch + WebSocket (browser & modern Node). No dependencies.

export type Fetcher = typeof fetch;

export interface PlutoClientOptions {
  /** Base URL, e.g. "https://api.example.com" or "http://localhost:3000" */
  baseUrl: string;
  /** Publishable / anon key sent as `apikey` header */
  apikey?: string;
  /** Optional bearer token (JWT). Prefer `signIn()` to manage this automatically. */
  accessToken?: string;
  /** Custom fetch (SSR polyfill, tests). Defaults to globalThis.fetch. */
  fetch?: Fetcher;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  user: { id: string; email?: string | null };
  expires_at?: number;
}

export class PlutoError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? `Pluto ${status}`);
  }
}

export interface QueryParams {
  table: string;
  select?: string[];
  filter?: Record<string, unknown>;
  order?: { column: string; ascending?: boolean }[];
  limit?: number;
  cursor?: string | null;
}

export interface QueryResult<T> {
  rows: T[];
  next_cursor: string | null;
}

export interface PublishParams {
  room: string;
  payload: unknown;
  /** Optional per-publisher sequence number; server enforces ordered delivery. */
  seq?: number;
}

export interface HybridSearchParams {
  index: string;
  query: string;
  vector?: number[];
  k?: number;
  alpha?: number; // lexical/vector blend weight
  filter?: Record<string, unknown>;
}

export interface HybridHit {
  id: string;
  score: number;
  lexical_score?: number;
  vector_score?: number;
  document?: unknown;
}

export interface WorkflowRunInput {
  workflow: string;
  input: unknown;
  idempotency_key?: string;
}

export interface WorkflowRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  workflow: string;
  input: unknown;
  output?: unknown;
  error?: string | null;
}

// ---------------------------------------------------------------------------

export class PlutoClient {
  private baseUrl: string;
  private apikey?: string;
  private accessToken?: string;
  private fetchImpl: Fetcher;
  private session?: Session;

  constructor(opts: PlutoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apikey = opts.apikey;
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ---- transport ------------------------------------------------------------

  private headers(extra?: HeadersInit): Headers {
    const h = new Headers(extra);
    if (!h.has("content-type")) h.set("content-type", "application/json");
    if (this.apikey) h.set("apikey", this.apikey);
    if (this.accessToken) h.set("authorization", `Bearer ${this.accessToken}`);
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    init?: { body?: unknown; headers?: HeadersInit; query?: Record<string, string | number | boolean | undefined> },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (init?.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(init.query)) if (v !== undefined) q.set(k, String(v));
      const s = q.toString();
      if (s) url += (url.includes("?") ? "&" : "?") + s;
    }
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(init?.headers),
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    const body = text ? safeJson(text) : undefined;
    if (!res.ok) throw new PlutoError(res.status, body, `${method} ${path} → ${res.status}`);
    return body as T;
  }

  /** Raw request escape hatch. */
  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // ---- auth (canonical `/auth/v1`) -----------------------------------------

  auth = {
    signUp: (email: string, password: string) =>
      this.request<Session>("POST", "/auth/v1/sign-up", { body: { email, password } }),

    signIn: async (email: string, password: string) => {
      const s = await this.request<Session>("POST", "/auth/v1/sign-in", { body: { email, password } });
      this.setSession(s);
      return s;
    },

    signOut: async () => {
      await this.request<void>("POST", "/auth/v1/sign-out");
      this.clearSession();
    },

    refresh: async (refresh_token?: string) => {
      const s = await this.request<Session>("POST", "/auth/v1/refresh", {
        body: { refresh_token: refresh_token ?? this.session?.refresh_token },
      });
      this.setSession(s);
      return s;
    },

    user: <U = unknown>() => this.request<U>("GET", "/auth/v1/user"),
  };

  setSession(s: Session) {
    this.session = s;
    this.accessToken = s.access_token;
  }
  clearSession() {
    this.session = undefined;
    this.accessToken = undefined;
  }
  getSession(): Session | undefined { return this.session; }

  // ---- data api v4 ---------------------------------------------------------

  data = {
    query: <T = Record<string, unknown>>(p: QueryParams) =>
      this.request<QueryResult<T>>("POST", "/rest/v4/query", { body: p }),

    rpc: <T = unknown>(name: string, args: Record<string, unknown> = {}) =>
      this.request<T>("POST", `/rest/v4/rpc/${encodeURIComponent(name)}`, { body: args }),

    /** NDJSON stream — iterate rows as they arrive. */
    stream: async function* <T = Record<string, unknown>>(
      this: PlutoClient,
      p: QueryParams & { chunk?: number },
    ): AsyncGenerator<T> {
      const url = `${this.baseUrl}/rest/v4/stream`;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers({ accept: "application/x-ndjson" }),
        body: JSON.stringify(p),
      });
      if (!res.ok || !res.body) throw new PlutoError(res.status, undefined, `stream → ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) yield JSON.parse(line) as T;
        }
      }
      if (buf.trim()) yield JSON.parse(buf) as T;
    },
  };

  // ---- storage v4 ----------------------------------------------------------

  storage = {
    upload: (bucket: string, key: string, body: Blob | ArrayBuffer | Uint8Array, contentType?: string) =>
      this.fetchImpl(`${this.baseUrl}/storage/v4/objects`, {
        method: "POST",
        headers: this.headers({
          "content-type": contentType ?? "application/octet-stream",
          "x-bucket": bucket,
          "x-key": key,
        }),
        body: body as BodyInit,
      }).then(async (r) => {
        if (!r.ok) throw new PlutoError(r.status, await r.text());
        return r.json() as Promise<{ bucket: string; key: string; version_id: string; size: number }>;
      }),

    listVersions: (bucket: string, key: string) =>
      this.request<{ versions: { version_id: string; created_at: string; size: number }[] }>(
        "GET",
        `/storage/v4/objects/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}/versions`,
      ),
  };

  // ---- realtime v5 (WS + publish REST) -------------------------------------

  realtime = {
    publish: (p: PublishParams) => this.request<{ ok: true; seq: number }>("POST", "/rt/v5/publish", { body: p }),

    roomStats: (room: string) =>
      this.request<{ room: string; queue_depth: number; subscribers: number; paused: boolean }>(
        "GET",
        `/rt/v5/room/${encodeURIComponent(room)}/stats`,
      ),

    /** Subscribe to a room. Delivers ordered `{seq, payload}` frames. */
    subscribe: (room: string, opts?: { onMessage?: (m: { seq: number; payload: unknown }) => void }) => {
      const wsUrl =
        this.baseUrl.replace(/^http/, "ws") +
        `/rt/v5/ws?room=${encodeURIComponent(room)}` +
        (this.accessToken ? `&token=${encodeURIComponent(this.accessToken)}` : "");
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("message", (e) => {
        try { opts?.onMessage?.(JSON.parse(String(e.data))); } catch { /* ignore */ }
      });
      return {
        close: () => ws.close(),
        socket: ws,
      };
    },
  };

  // ---- vector v3 -----------------------------------------------------------

  vector = {
    hybridSearch: (p: HybridSearchParams) =>
      this.request<{ hits: HybridHit[] }>("POST", "/vec/v3/hybrid/search", { body: p }),

    /** Streaming embeddings — yields batches as they complete. */
    embeddingsStream: async function* (
      this: PlutoClient,
      inputs: string[],
      model: string,
    ): AsyncGenerator<{ index: number; embedding: number[] }> {
      const res = await this.fetchImpl(`${this.baseUrl}/vec/v3/embeddings/stream`, {
        method: "POST",
        headers: this.headers({ accept: "application/x-ndjson" }),
        body: JSON.stringify({ inputs, model }),
      });
      if (!res.ok || !res.body) throw new PlutoError(res.status, undefined);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) yield JSON.parse(line);
        }
      }
    },
  };

  // ---- jobs v2 -------------------------------------------------------------

  jobs = {
    run: (p: WorkflowRunInput) => this.request<WorkflowRun>("POST", "/jobs/v2/runs", { body: p }),
    status: (id: string) => this.request<WorkflowRun>("GET", `/jobs/v2/runs/${encodeURIComponent(id)}`),
    listWorkflows: () =>
      this.request<{ workflows: { name: string; version: number; description?: string }[] }>(
        "GET",
        "/jobs/v2/workflows",
      ),
  };

  // ---- ai -----------------------------------------------------------------

  ai = {
    chat: <T = unknown>(body: unknown) => this.request<T>("POST", "/ai/v1/chat/completions", { body }),
    embed: (body: { input: string | string[]; model: string }) =>
      this.request<{ data: { embedding: number[]; index: number }[] }>("POST", "/ai/v1/embeddings", { body }),
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Convenience factory. */
export function createClient(opts: PlutoClientOptions): PlutoClient {
  return new PlutoClient(opts);
}
