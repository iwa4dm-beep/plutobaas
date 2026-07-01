/**
 * @pluto/client — fetch-based BaaS SDK.
 *
 * Works in browsers, Node 18+, edge runtimes, and React Native.
 * Real Phase-2 implementation: talks to Pluto `/auth/v1` and `/rest/v1`.
 * Storage helpers land in Phase 3.
 */

export type PlutoClientOptions = {
  url: string;
  anonKey: string;
  persistSession?: boolean;
  storageKey?: string;
};

export type Session = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { id: string; email: string; role: "admin" | "user" };
};

type Listener = (s: Session | null) => void;

const isBrowser = typeof globalThis !== "undefined" && typeof (globalThis as { localStorage?: unknown }).localStorage !== "undefined";

class Auth {
  private session: Session | null = null;
  private listeners = new Set<Listener>();
  constructor(private opts: Required<Pick<PlutoClientOptions, "url" | "anonKey" | "storageKey">> & { persist: boolean }) {
    if (opts.persist && isBrowser) {
      const raw = localStorage.getItem(opts.storageKey);
      if (raw) { try { this.session = JSON.parse(raw); } catch { /* ignore */ } }
    }
  }
  private persist() {
    if (!this.opts.persist || !isBrowser) return;
    if (this.session) localStorage.setItem(this.opts.storageKey, JSON.stringify(this.session));
    else localStorage.removeItem(this.opts.storageKey);
  }
  private setSession(s: Session | null) {
    this.session = s;
    this.persist();
    for (const l of this.listeners) l(s);
  }
  getSession() { return this.session; }
  onAuthStateChange(cb: Listener) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  private async call(path: string, body: unknown) {
    const res = await fetch(`${this.opts.url}/auth/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: this.opts.anonKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
    return res.json();
  }
  async signUp(args: { email: string; password: string }) {
    const out = await this.call("/sign-up", args);
    this.setSession(out.session);
    return out;
  }
  async signIn(args: { email: string; password: string }) {
    const out = await this.call("/sign-in", args);
    this.setSession(out.session);
    return out;
  }
  async signOut() {
    if (this.session) {
      await fetch(`${this.opts.url}/auth/v1/sign-out`, {
        method: "POST",
        headers: { apikey: this.opts.anonKey, authorization: `Bearer ${this.session.access_token}` },
      }).catch(() => {});
    }
    this.setSession(null);
  }
  async refresh() {
    if (!this.session) throw new Error("no_session");
    const out = await this.call("/refresh", { refresh_token: this.session.refresh_token });
    this.setSession(out.session);
    return out.session as Session;
  }
  authHeader(): Record<string, string> {
    return this.session ? { authorization: `Bearer ${this.session.access_token}` } : {};
  }
}

class QueryBuilder<T> {
  private filters: string[] = [];
  private _select = "*";
  private _order?: string;
  private _limit?: number;
  private _offset?: number;
  private _method: "GET" | "POST" | "PATCH" | "DELETE" = "GET";
  private _body?: unknown;

  constructor(private url: string, private table: string, private headers: () => Record<string, string>) {}

  select(cols = "*") { this._select = cols; return this; }
  eq(col: keyof T & string, value: unknown) { this.filters.push(`${col}=eq.${encodeURIComponent(String(value))}`); return this; }
  neq(col: keyof T & string, value: unknown) { this.filters.push(`${col}=neq.${encodeURIComponent(String(value))}`); return this; }
  gt(col: keyof T & string, value: unknown) { this.filters.push(`${col}=gt.${encodeURIComponent(String(value))}`); return this; }
  gte(col: keyof T & string, value: unknown) { this.filters.push(`${col}=gte.${encodeURIComponent(String(value))}`); return this; }
  lt(col: keyof T & string, value: unknown) { this.filters.push(`${col}=lt.${encodeURIComponent(String(value))}`); return this; }
  lte(col: keyof T & string, value: unknown) { this.filters.push(`${col}=lte.${encodeURIComponent(String(value))}`); return this; }
  like(col: keyof T & string, pattern: string) { this.filters.push(`${col}=like.${encodeURIComponent(pattern)}`); return this; }
  ilike(col: keyof T & string, pattern: string) { this.filters.push(`${col}=ilike.${encodeURIComponent(pattern)}`); return this; }
  in(col: keyof T & string, values: unknown[]) { this.filters.push(`${col}=in.(${values.map((v) => encodeURIComponent(String(v))).join(",")})`); return this; }
  is(col: keyof T & string, value: null | "not.null") { this.filters.push(`${col}=is.${value === null ? "null" : "not.null"}`); return this; }
  order(col: keyof T & string, opts?: { ascending?: boolean }) { this._order = `${col}.${opts?.ascending === false ? "desc" : "asc"}`; return this; }
  limit(n: number) { this._limit = n; return this; }
  range(from: number, to: number) { this._offset = from; this._limit = to - from + 1; return this; }

  insert(row: Partial<T> | Partial<T>[]) { this._method = "POST"; this._body = row; return this; }
  update(patch: Partial<T>) { this._method = "PATCH"; this._body = patch; return this; }
  delete() { this._method = "DELETE"; return this; }

  private buildUrl() {
    const params: string[] = [...this.filters];
    if (this._select !== "*") params.push(`select=${encodeURIComponent(this._select)}`);
    if (this._order) params.push(`order=${this._order}`);
    if (this._limit != null) params.push(`limit=${this._limit}`);
    if (this._offset != null) params.push(`offset=${this._offset}`);
    return `${this.url}/rest/v1/${this.table}${params.length ? "?" + params.join("&") : ""}`;
  }

  async execute<R = T[]>(): Promise<{ data: R | null; error: Error | null }> {
    try {
      const res = await fetch(this.buildUrl(), {
        method: this._method,
        headers: {
          ...this.headers(),
          ...(this._body ? { "content-type": "application/json" } : {}),
        },
        body: this._body ? JSON.stringify(this._body) : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        return { data: null, error: new Error(err.error ?? "request_failed") };
      }
      return { data: (await res.json()) as R, error: null };
    } catch (e) {
      return { data: null, error: e instanceof Error ? e : new Error("network_error") };
    }
  }

  then<R>(onfulfilled: (v: { data: T[] | null; error: Error | null }) => R): Promise<R> {
    return this.execute<T[]>().then(onfulfilled);
  }
}

class StorageBucket {
  constructor(private base: string, private bucket: string, private headers: () => Record<string, string>) {}
  async upload(path: string, file: Blob | File | ArrayBuffer | Uint8Array, opts?: { contentType?: string }) {
    const fd = new FormData();
    const blob = file instanceof Blob ? file : new Blob([file as BlobPart], { type: opts?.contentType ?? "application/octet-stream" });
    fd.append("file", blob, path.split("/").pop() ?? "file");
    const res = await fetch(`${this.base}/storage/v1/object/${this.bucket}/${encodeURI(path)}`, {
      method: "POST", headers: this.headers(), body: fd,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
    return res.json() as Promise<{ bucket: string; key: string; size: number }>;
  }
  async download(path: string): Promise<Blob> {
    const res = await fetch(`${this.base}/storage/v1/object/${this.bucket}/${encodeURI(path)}`, { headers: this.headers() });
    if (!res.ok) throw new Error("not_found");
    return res.blob();
  }
  async remove(paths: string[]) {
    await Promise.all(paths.map((p) => fetch(`${this.base}/storage/v1/object/${this.bucket}/${encodeURI(p)}`, {
      method: "DELETE", headers: this.headers(),
    })));
  }
  async createSignedUrl(path: string, expiresIn: number, mode: "read" | "write" = "read") {
    const res = await fetch(`${this.base}/storage/v1/object/sign/${this.bucket}/${encodeURI(path)}`, {
      method: "POST", headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ expires_in: expiresIn, mode }),
    });
    if (!res.ok) throw new Error("sign_failed");
    return res.json() as Promise<{ url: string; expires_in: number }>;
  }
  getPublicUrl(path: string) {
    return { publicUrl: `${this.base}/storage/v1/object/public/${this.bucket}/${encodeURI(path)}` };
  }
  async list(prefix?: string) {
    const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
    const res = await fetch(`${this.base}/storage/v1/list/${this.bucket}${q}`, { headers: this.headers() });
    if (!res.ok) throw new Error("list_failed");
    return res.json();
  }
}

class Storage {
  constructor(private base: string, private headers: () => Record<string, string>) {}
  from(bucket: string) { return new StorageBucket(this.base, bucket, this.headers); }
  async listBuckets() {
    const res = await fetch(`${this.base}/storage/v1/buckets`, { headers: this.headers() });
    return res.json();
  }
  async createBucket(name: string, opts?: { public?: boolean }) {
    const res = await fetch(`${this.base}/storage/v1/buckets`, {
      method: "POST", headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ name, public: opts?.public ?? false }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
    return res.json();
  }
}

export class PlutoClient {
  auth: Auth;
  storage: Storage;
  private base: string;
  constructor(private opts: PlutoClientOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.auth = new Auth({
      url: this.base,
      anonKey: opts.anonKey,
      storageKey: opts.storageKey ?? "pluto.session",
      persist: opts.persistSession ?? isBrowser,
    });
    this.storage = new Storage(this.base, () => ({ apikey: opts.anonKey, ...this.auth.authHeader() }));
  }
  from<T = Record<string, unknown>>(table: string) {
    return new QueryBuilder<T>(this.base, table, () => ({
      apikey: this.opts.anonKey,
      ...this.auth.authHeader(),
    }));
  }
}

export function createPlutoClient(opts: PlutoClientOptions) {
  return new PlutoClient(opts);
}

