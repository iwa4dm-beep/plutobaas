/**
 * @pluto/js — Public SDK for Pluto BaaS.
 * Supabase-compatible surface so migration is trivial:
 *
 *   import { createClient } from '@pluto/js'
 *   const pluto = createClient(url, publishableKey)
 *   await pluto.auth.signInWithPassword({ email, password })
 *   const { data, error } = await pluto.from('posts').select('*').eq('published', true)
 */

// ---------- Types ----------

export interface Session {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  user: User;
}

export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  role: string;
  user_metadata: Record<string, any>;
  app_metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface PlutoError {
  message: string;
  code?: string;
  details?: any;
  status?: number;
}

export interface PlutoResponse<T> {
  data: T | null;
  error: PlutoError | null;
  status: number;
  count?: number;
}

export type AuthEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED';

export type AuthChangeCallback = (event: AuthEvent, session: Session | null) => void;

// ---------- Storage adapter ----------

export interface StorageAdapter {
  getItem(k: string): string | null | Promise<string | null>;
  setItem(k: string, v: string): void | Promise<void>;
  removeItem(k: string): void | Promise<void>;
}

const memoryStorage: StorageAdapter = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
})();

function defaultStorage(): StorageAdapter {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage as StorageAdapter;
  return memoryStorage;
}

// ---------- Client options ----------

export interface PlutoClientOptions {
  auth?: {
    storage?: StorageAdapter;
    storageKey?: string;
    autoRefreshToken?: boolean;
    persistSession?: boolean;
  };
  global?: {
    fetch?: typeof fetch;
    headers?: Record<string, string>;
  };
}

// ---------- Auth ----------

class AuthClient {
  private session: Session | null = null;
  private listeners = new Set<AuthChangeCallback>();
  private refreshTimer: any = null;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private storage: StorageAdapter,
    private storageKey: string,
    private autoRefresh: boolean,
    private fetchImpl: typeof fetch,
  ) {
    void this.loadSession();
  }

  private async loadSession() {
    const raw = await this.storage.getItem(this.storageKey);
    if (raw) {
      try {
        const s = JSON.parse(raw) as Session;
        if (s.expires_at * 1000 > Date.now()) {
          this.session = s;
          this.scheduleRefresh();
        } else if (s.refresh_token) {
          await this._refresh(s.refresh_token).catch(() => {});
        }
      } catch {}
    }
    this.emit('INITIAL_SESSION', this.session);
  }

  private async persist(s: Session | null) {
    this.session = s;
    if (s) await this.storage.setItem(this.storageKey, JSON.stringify(s));
    else await this.storage.removeItem(this.storageKey);
    this.scheduleRefresh();
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.autoRefresh || !this.session) return;
    const msUntil = this.session.expires_at * 1000 - Date.now() - 60_000;
    if (msUntil <= 0) { void this._refresh(this.session.refresh_token); return; }
    this.refreshTimer = setTimeout(() => { void this._refresh(this.session!.refresh_token); }, msUntil);
  }

  private emit(event: AuthEvent, s: Session | null) {
    for (const cb of this.listeners) { try { cb(event, s); } catch {} }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: this.apiKey,
        Authorization: `Bearer ${this.session?.access_token ?? this.apiKey}`,
        ...(init?.headers as any),
      },
    });
    if (!res.ok) throw Object.assign(new Error((await res.text()) || res.statusText), { status: res.status });
    if (res.status === 204) return null as any;
    return res.json();
  }

  private async _refresh(refresh_token: string) {
    const s = await this.request<Session>('/auth/v1/token', {
      method: 'POST',
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token }),
    });
    await this.persist(s);
    this.emit('TOKEN_REFRESHED', s);
    return s;
  }

  // -------- Public API --------

  getSession(): { data: { session: Session | null }; error: null } {
    return { data: { session: this.session }, error: null };
  }

  getUser(): { data: { user: User | null }; error: null } {
    return { data: { user: this.session?.user ?? null }, error: null };
  }

  onAuthStateChange(cb: AuthChangeCallback) {
    this.listeners.add(cb);
    return { data: { subscription: { unsubscribe: () => this.listeners.delete(cb) } } };
  }

  async signUp(creds: { email: string; password: string; options?: { data?: Record<string, any> } }) {
    try {
      const s = await this.request<Session>('/auth/v1/signup', {
        method: 'POST',
        body: JSON.stringify({ email: creds.email, password: creds.password, data: creds.options?.data }),
      });
      await this.persist(s);
      this.emit('SIGNED_IN', s);
      return { data: { user: s.user, session: s }, error: null };
    } catch (e: any) {
      return { data: { user: null, session: null }, error: { message: e.message, status: e.status } };
    }
  }

  async signInWithPassword(creds: { email: string; password: string }) {
    try {
      const s = await this.request<Session>('/auth/v1/token', {
        method: 'POST',
        body: JSON.stringify({ grant_type: 'password', email: creds.email, password: creds.password }),
      });
      await this.persist(s);
      this.emit('SIGNED_IN', s);
      return { data: { user: s.user, session: s }, error: null };
    } catch (e: any) {
      return { data: { user: null, session: null }, error: { message: e.message, status: e.status } };
    }
  }

  async signOut() {
    try { await this.request('/auth/v1/logout', { method: 'POST' }); } catch {}
    await this.persist(null);
    this.emit('SIGNED_OUT', null);
    return { error: null };
  }

  async updateUser(patch: { email?: string; password?: string; data?: Record<string, any> }) {
    try {
      const u = await this.request<User>('/auth/v1/user', { method: 'PUT', body: JSON.stringify(patch) });
      if (this.session) await this.persist({ ...this.session, user: u });
      this.emit('USER_UPDATED', this.session);
      return { data: { user: u }, error: null };
    } catch (e: any) {
      return { data: { user: null }, error: { message: e.message, status: e.status } };
    }
  }

  async resetPasswordForEmail(email: string) {
    try {
      await this.request('/auth/v1/recover', { method: 'POST', body: JSON.stringify({ email }) });
      return { data: {}, error: null };
    } catch (e: any) {
      return { data: null, error: { message: e.message, status: e.status } };
    }
  }

  // Internal — used by from()/storage
  _authHeader(): Record<string, string> {
    return {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.session?.access_token ?? this.apiKey}`,
    };
  }
}

// ---------- Query builder ----------

type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in';

class QueryBuilder<T = any> {
  private filters: string[] = [];
  private _select = '*';
  private _order?: string;
  private _limit?: number;
  private _offset?: number;
  private method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET';
  private body: any = null;
  private prefer: string[] = [];
  private onConflict?: string;

  constructor(
    private baseUrl: string,
    private table: string,
    private authHeader: () => Record<string, string>,
    private fetchImpl: typeof fetch,
  ) {}

  select(cols = '*') { this._select = cols; return this; }
  order(col: string, opts?: { ascending?: boolean }) { this._order = `${col}.${opts?.ascending === false ? 'desc' : 'asc'}`; return this; }
  limit(n: number) { this._limit = n; return this; }
  range(from: number, to: number) { this._offset = from; this._limit = to - from + 1; return this; }

  private filter(col: string, op: Op, value: any) {
    let v: string;
    if (op === 'in' && Array.isArray(value)) v = `in.(${value.join(',')})`;
    else if (op === 'is') v = `is.${value === null ? 'null' : value}`;
    else v = `${op}.${value}`;
    this.filters.push(`${encodeURIComponent(col)}=${encodeURIComponent(v)}`);
    return this;
  }
  eq(c: string, v: any) { return this.filter(c, 'eq', v); }
  neq(c: string, v: any) { return this.filter(c, 'neq', v); }
  gt(c: string, v: any) { return this.filter(c, 'gt', v); }
  gte(c: string, v: any) { return this.filter(c, 'gte', v); }
  lt(c: string, v: any) { return this.filter(c, 'lt', v); }
  lte(c: string, v: any) { return this.filter(c, 'lte', v); }
  like(c: string, v: string) { return this.filter(c, 'like', v); }
  ilike(c: string, v: string) { return this.filter(c, 'ilike', v); }
  is(c: string, v: null | boolean) { return this.filter(c, 'is', v); }
  in(c: string, v: any[]) { return this.filter(c, 'in', v); }

  insert(rows: Partial<T> | Partial<T>[]) { this.method = 'POST'; this.body = rows; return this; }
  update(patch: Partial<T>) { this.method = 'PATCH'; this.body = patch; return this; }
  upsert(rows: Partial<T> | Partial<T>[], opts?: { onConflict?: string }) {
    this.method = 'POST'; this.body = rows;
    this.prefer.push('resolution=merge-duplicates');
    if (opts?.onConflict) this.onConflict = opts.onConflict;
    return this;
  }
  delete() { this.method = 'DELETE'; return this; }

  single(): this { this.prefer.push('return=representation'); return this; }

  async then<TR1 = PlutoResponse<T[]>, TR2 = never>(
    resolve?: ((v: PlutoResponse<T[]>) => TR1 | PromiseLike<TR1>) | null,
    reject?: ((r: any) => TR2 | PromiseLike<TR2>) | null,
  ): Promise<TR1 | TR2> {
    return this.execute().then(resolve as any, reject as any);
  }

  private async execute(): Promise<PlutoResponse<T[]>> {
    const qs: string[] = [];
    if (this.method === 'GET') qs.push(`select=${encodeURIComponent(this._select)}`);
    if (this._order) qs.push(`order=${this._order}`);
    if (this._limit != null) qs.push(`limit=${this._limit}`);
    if (this._offset != null) qs.push(`offset=${this._offset}`);
    if (this.onConflict) qs.push(`on_conflict=${encodeURIComponent(this.onConflict)}`);
    qs.push(...this.filters);
    const url = `${this.baseUrl}/rest/v1/${encodeURIComponent(this.table)}${qs.length ? '?' + qs.join('&') : ''}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...this.authHeader(),
    };
    if (this.prefer.length) headers['Prefer'] = this.prefer.join(',');

    try {
      const res = await this.fetchImpl(url, {
        method: this.method,
        headers,
        body: this.body ? JSON.stringify(this.body) : undefined,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) {
        return { data: null, error: { message: (data && data.message) || res.statusText, status: res.status, details: data }, status: res.status };
      }
      return { data, error: null, status: res.status };
    } catch (e: any) {
      return { data: null, error: { message: e.message }, status: 0 };
    }
  }
}

// ---------- Storage stub (Phase 5 will implement) ----------

class StorageClient {
  constructor(private baseUrl: string, private authHeader: () => Record<string, string>, private fetchImpl: typeof fetch) {}
  from(bucket: string) {
    return {
      upload: async (path: string, file: Blob | ArrayBuffer | Uint8Array, opts?: { contentType?: string; upsert?: boolean }) => {
        const url = `${this.baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`;
        const res = await this.fetchImpl(url, {
          method: opts?.upsert ? 'PUT' : 'POST',
          headers: { 'Content-Type': opts?.contentType || 'application/octet-stream', ...this.authHeader() },
          body: file as any,
        });
        if (!res.ok) return { data: null, error: { message: await res.text(), status: res.status } };
        return { data: { path }, error: null };
      },
      download: async (path: string) => {
        const url = `${this.baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${path}`;
        const res = await this.fetchImpl(url, { headers: this.authHeader() });
        if (!res.ok) return { data: null, error: { message: await res.text(), status: res.status } };
        return { data: await res.blob(), error: null };
      },
      remove: async (paths: string[]) => {
        const res = await this.fetchImpl(`${this.baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...this.authHeader() },
          body: JSON.stringify({ prefixes: paths }),
        });
        if (!res.ok) return { data: null, error: { message: await res.text(), status: res.status } };
        return { data: await res.json().catch(() => ({})), error: null };
      },
      getPublicUrl: (path: string) => ({
        data: { publicUrl: `${this.baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${path}` },
      }),
    };
  }
}

// ---------- Realtime stub (Phase 6 will implement) ----------

class RealtimeClient {
  constructor(private baseUrl: string, private apiKey: string) {}
  channel(name: string) {
    let ws: any = null;
    const listeners: Array<{ event: string; cb: (p: any) => void }> = [];
    const api = {
      on(_type: string, filter: any, cb: (payload: any) => void) {
        listeners.push({ event: typeof filter === 'string' ? filter : filter?.event || '*', cb });
        return api;
      },
      async subscribe(cb?: (status: string) => void) {
        try {
          const url = this.baseUrl.replace(/^http/, 'ws') + `/realtime/v1?apikey=${encodeURIComponent(this.apiKey)}&channel=${encodeURIComponent(name)}`;
          ws = new (globalThis as any).WebSocket(url);
          ws.onopen = () => cb?.('SUBSCRIBED');
          ws.onmessage = (m: any) => {
            let payload: any; try { payload = JSON.parse(m.data); } catch { return; }
            for (const l of listeners) if (l.event === '*' || l.event === payload.event) l.cb(payload);
          };
          ws.onerror = () => cb?.('CHANNEL_ERROR');
          ws.onclose = () => cb?.('CLOSED');
        } catch (e) { cb?.('CHANNEL_ERROR'); }
        return api;
      },
      unsubscribe() { try { ws?.close(); } catch {} return api; },
    } as any;
    // bind baseUrl/apiKey into subscribe
    api.subscribe = api.subscribe.bind({ baseUrl: this.baseUrl, apiKey: this.apiKey });
    return api;
  }
}

// ---------- Onboarding / admin helpers ----------

export interface SignupFullPayload {
  email: string;
  password: string;
  workspace_name?: string;
  project_name?: string;
  domain?: string;
  seed_demo?: boolean;
}

export interface SignupFullResult {
  user: User;
  session: Session;
  workspace: { id: string; name: string };
  project: { id: string; name: string };
  api_keys: { publishable: string; secret: string };
}

export interface Invite {
  id: string;
  email: string;
  role: string;
  token?: string;
  expires_at: string;
  accepted_at: string | null;
}

export interface Domain {
  id: string;
  origin: string;
  description: string | null;
  enabled: boolean;
  created_at: string;
}

class OnboardingClient {
  constructor(private baseUrl: string, private apiKey: string, private authHeader: () => Record<string, string>, private fetchImpl: typeof fetch) {}
  private async req<T>(path: string, init: RequestInit, auth = false): Promise<PlutoResponse<T>> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: this.apiKey, ...(init.headers as any) };
      if (auth) Object.assign(headers, this.authHeader());
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) return { data: null, error: { message: (data && data.message) || res.statusText, status: res.status }, status: res.status };
      return { data, error: null, status: res.status };
    } catch (e: any) {
      return { data: null, error: { message: e.message }, status: 0 };
    }
  }
  signupFull(payload: SignupFullPayload) {
    return this.req<SignupFullResult>('/auth/v1/signup-full', { method: 'POST', body: JSON.stringify(payload) });
  }
  acceptInvite(token: string, password: string) {
    return this.req<{ user: User; session: Session }>('/auth/v1/accept-invite', { method: 'POST', body: JSON.stringify({ token, password }) });
  }
  createInvite(email: string, role = 'admin') {
    return this.req<Invite>('/admin/v1/invite', { method: 'POST', body: JSON.stringify({ email, role }) }, true);
  }
}

class DomainsClient {
  constructor(private baseUrl: string, private authHeader: () => Record<string, string>, private fetchImpl: typeof fetch) {}
  private async req<T>(path: string, init: RequestInit = {}): Promise<PlutoResponse<T>> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...this.authHeader(), ...(init.headers as any) } });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) return { data: null, error: { message: (data && data.message) || res.statusText, status: res.status }, status: res.status };
      return { data, error: null, status: res.status };
    } catch (e: any) {
      return { data: null, error: { message: e.message }, status: 0 };
    }
  }
  list(projectId: string) { return this.req<Domain[]>(`/admin/v1/projects/${encodeURIComponent(projectId)}/domains`); }
  add(projectId: string, origin: string, description?: string) {
    return this.req<Domain>(`/admin/v1/projects/${encodeURIComponent(projectId)}/domains`, { method: 'POST', body: JSON.stringify({ origin, description }) });
  }
  remove(projectId: string, domainId: string) {
    return this.req<{ ok: true }>(`/admin/v1/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domainId)}`, { method: 'DELETE' });
  }
}

// ---------- Main client ----------

export class PlutoClient {
  auth: AuthClient;
  storage: StorageClient;
  realtime: RealtimeClient;
  onboarding: OnboardingClient;
  domains: DomainsClient;
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(url: string, apiKey: string, opts: PlutoClientOptions = {}) {
    if (!url) throw new Error('Pluto: url required');
    if (!apiKey) throw new Error('Pluto: apiKey required');
    this.baseUrl = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = opts.global?.fetch ?? globalThis.fetch.bind(globalThis);
    this.auth = new AuthClient(
      this.baseUrl,
      apiKey,
      opts.auth?.storage ?? defaultStorage(),
      opts.auth?.storageKey ?? `pluto.auth.${apiKey.slice(0, 12)}`,
      opts.auth?.autoRefreshToken !== false,
      this.fetchImpl,
    );
    this.storage = new StorageClient(this.baseUrl, () => this.auth._authHeader(), this.fetchImpl);
    this.realtime = new RealtimeClient(this.baseUrl, apiKey);
    this.onboarding = new OnboardingClient(this.baseUrl, apiKey, () => this.auth._authHeader(), this.fetchImpl);
    this.domains = new DomainsClient(this.baseUrl, () => this.auth._authHeader(), this.fetchImpl);
  }

  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.baseUrl, table, () => this.auth._authHeader(), this.fetchImpl);
  }

  channel(name: string) { return this.realtime.channel(name); }

  async rpc<T = any>(fn: string, args?: Record<string, any>): Promise<PlutoResponse<T>> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.auth._authHeader() },
        body: JSON.stringify(args || {}),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) return { data: null, error: { message: (data && data.message) || res.statusText, status: res.status }, status: res.status };
      return { data, error: null, status: res.status };
    } catch (e: any) {
      return { data: null, error: { message: e.message }, status: 0 };
    }
  }
}

export function createClient(url: string, apiKey: string, opts?: PlutoClientOptions) {
  return new PlutoClient(url, apiKey, opts);
}

export default createClient;

