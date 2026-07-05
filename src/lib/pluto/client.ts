/**
 * @pluto/client — adapter SDK
 *
 * Public shape is stable. When `VITE_PLUTO_URL` (+ `VITE_PLUTO_ANON_KEY`)
 * are configured, every method routes to the real Fastify backend via
 * `./live`. Otherwise it falls back to a localStorage-backed mock so the
 * dashboard remains fully interactive with no backend.
 *
 * Adding a new method? Add both a `live` branch and a `mock` branch inside
 * the same function so callers never need to know which is active.
 */

import { isLive, live, type AdminUser, type LogEntry, type SqlResult } from "./live";

export type PlutoUser = {
  id: string;
  email: string;
  role: "admin" | "user";
  created_at: string;
  email_verified: boolean;
};

export type PlutoSession = {
  access_token: string;
  refresh_token: string;
  user: PlutoUser;
  expires_at: number;
};

export type PlutoTable = {
  name: string;
  schema: "public";
  columns: { name: string; type: string; nullable: boolean; pk?: boolean }[];
  row_count: number;
};

export type PlutoBucket = { name: string; public: boolean; file_count: number; size_bytes: number };
export type PlutoFile = { key: string; size: number; content_type: string; updated_at: string };
export type PlutoLog = {
  id: string;
  ts: string;
  level: "info" | "warn" | "error";
  source: "auth" | "rest" | "storage" | "admin";
  message: string;
};

export type PlutoSettings = {
  backendUrl: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  storageDriver: "local" | "s3";
  s3Bucket: string;
  s3Region: string;
  jwtRotatedAt: string | null;
};

// ---------- Mock backing store ----------

const STORAGE_KEY = "pluto.mock.v1";

type MockDB = {
  session: PlutoSession | null;
  users: PlutoUser[];
  tables: PlutoTable[];
  rows: Record<string, Record<string, unknown>[]>;
  buckets: PlutoBucket[];
  files: Record<string, PlutoFile[]>;
  logs: PlutoLog[];
  settings: PlutoSettings;
};

const seed = (): MockDB => ({
  session: null,
  users: [
    { id: "u_001", email: "admin@pluto.local", role: "admin", email_verified: true, created_at: new Date(Date.now() - 86400000 * 14).toISOString() },
    { id: "u_002", email: "alice@example.com", role: "user", email_verified: true, created_at: new Date(Date.now() - 86400000 * 7).toISOString() },
    { id: "u_003", email: "bob@example.com", role: "user", email_verified: false, created_at: new Date(Date.now() - 86400000 * 2).toISOString() },
  ],
  tables: [
    {
      name: "posts", schema: "public", row_count: 3,
      columns: [
        { name: "id", type: "uuid", nullable: false, pk: true },
        { name: "title", type: "text", nullable: false },
        { name: "body", type: "text", nullable: true },
        { name: "author_id", type: "uuid", nullable: false },
        { name: "created_at", type: "timestamptz", nullable: false },
      ],
    },
    {
      name: "profiles", schema: "public", row_count: 3,
      columns: [
        { name: "id", type: "uuid", nullable: false, pk: true },
        { name: "user_id", type: "uuid", nullable: false },
        { name: "display_name", type: "text", nullable: true },
      ],
    },
  ],
  rows: {
    posts: [
      { id: "p1", title: "Hello Pluto", body: "First post", author_id: "u_002", created_at: new Date().toISOString() },
      { id: "p2", title: "Self-hosted BaaS", body: "Auth + REST + Storage", author_id: "u_002", created_at: new Date().toISOString() },
      { id: "p3", title: "Docker compose up", body: "One command setup", author_id: "u_003", created_at: new Date().toISOString() },
    ],
    profiles: [
      { id: "pr1", user_id: "u_001", display_name: "Admin" },
      { id: "pr2", user_id: "u_002", display_name: "Alice" },
      { id: "pr3", user_id: "u_003", display_name: "Bob" },
    ],
  },
  buckets: [
    { name: "avatars", public: true, file_count: 2, size_bytes: 51200 },
    { name: "uploads", public: false, file_count: 1, size_bytes: 204800 },
  ],
  files: {
    avatars: [
      { key: "u_002.png", size: 25600, content_type: "image/png", updated_at: new Date().toISOString() },
      { key: "u_003.png", size: 25600, content_type: "image/png", updated_at: new Date().toISOString() },
    ],
    uploads: [
      { key: "report.pdf", size: 204800, content_type: "application/pdf", updated_at: new Date().toISOString() },
    ],
  },
  logs: Array.from({ length: 18 }).map((_, i) => ({
    id: `l_${i}`,
    ts: new Date(Date.now() - i * 60000).toISOString(),
    level: (["info", "info", "info", "warn", "error"] as const)[i % 5],
    source: (["auth", "rest", "storage", "admin"] as const)[i % 4],
    message: ["sign-in ok", "GET /rest/v1/posts 200", "upload avatars/u_002.png", "rate-limit warn", "invalid jwt"][i % 5],
  })),
  settings: {
    backendUrl: "http://localhost:8000",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUser: "no-reply@example.com",
    storageDriver: "local",
    s3Bucket: "",
    s3Region: "us-east-1",
    jwtRotatedAt: null,
  },
});

function load(): MockDB {
  if (typeof window === "undefined") return seed();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const fresh = seed();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      return fresh;
    }
    return JSON.parse(raw) as MockDB;
  } catch {
    return seed();
  }
}

function save(db: MockDB) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

const wait = (ms = 180) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 10);

// ---------- Adapters (live → public shape) ----------

function adaptAuthUser(u: { id: string; email: string; role: "admin" | "user"; email_verified?: boolean; created_at?: string }): PlutoUser {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    email_verified: u.email_verified ?? false,
    created_at: u.created_at ?? new Date().toISOString(),
  };
}

function adaptAdminUser(u: AdminUser): PlutoUser {
  return adaptAuthUser(u);
}

function adaptLog(l: LogEntry): PlutoLog {
  const level = (["info", "warn", "error"].includes(l.level) ? l.level : "info") as PlutoLog["level"];
  const source = (["auth", "rest", "storage", "admin"].includes(l.source) ? l.source : "admin") as PlutoLog["source"];
  return { id: l.id, ts: l.ts, level, source, message: l.message };
}

/** SqlResult → mock-shaped `{ columns, rows }`. */
function adaptSqlResult(res: SqlResult | undefined): { columns: string[]; rows: unknown[][] } {
  if (!res) return { columns: [], rows: [] };
  const columns = res.columns.map((c) => c.name);
  const rows = (res.rows as Record<string, unknown>[]).map((r) => columns.map((c) => r[c]));
  return { columns, rows };
}

// ---------- Public API ----------

export const pluto = {
  /** True when calls go to the real Fastify backend. */
  isLive: () => isLive(),

  auth: {
    async signIn(email: string, password: string): Promise<PlutoSession> {
      if (!email || !password) throw new Error("Email এবং password দিন।");
      if (isLive()) {
        const r = await live.auth.signIn(email, password);
        return {
          access_token: r.session.access_token,
          refresh_token: r.session.refresh_token,
          expires_at: r.session.expires_at,
          user: adaptAuthUser(r.user),
        };
      }
      await wait();
      const db = load();
      let user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (!user) {
        user = { id: `u_${rid()}`, email, role: "admin", email_verified: true, created_at: new Date().toISOString() };
        db.users.unshift(user);
      }
      const session: PlutoSession = {
        access_token: `mock.${rid()}.${rid()}`,
        refresh_token: `mock.${rid()}`,
        user,
        expires_at: Date.now() + 15 * 60 * 1000,
      };
      db.session = session;
      db.logs.unshift({ id: `l_${rid()}`, ts: new Date().toISOString(), level: "info", source: "auth", message: `sign-in ${email}` });
      save(db);
      return session;
    },

    async signUp(email: string, password: string): Promise<PlutoSession> {
      if (isLive()) {
        const r = await live.auth.signUp(email, password);
        return {
          access_token: r.session.access_token,
          refresh_token: r.session.refresh_token,
          expires_at: r.session.expires_at,
          user: adaptAuthUser(r.user),
        };
      }
      // Mock: signUp behaves like signIn for the demo dashboard.
      return this.signIn(email, password);
    },

    async signOut() {
      if (isLive()) { await live.auth.signOut(); return; }
      const db = load();
      db.session = null;
      save(db);
    },

    getSession(): PlutoSession | null {
      if (isLive()) {
        const s = live.auth.session();
        if (!s || !s.user) return null;
        return {
          access_token: s.access_token,
          refresh_token: s.refresh_token,
          expires_at: s.expires_at,
          user: adaptAuthUser(s.user),
        };
      }
      return load().session;
    },
  },

  db: {
    async listTables(): Promise<PlutoTable[]> {
      if (isLive()) {
        try {
          const { tables } = await live.schema.introspect();
          // Coerce live shape into the simpler mock shape.
          return (tables ?? []).filter((t) => t.schema === "public").map((t) => ({
            name: t.name,
            schema: "public",
            row_count: (t as unknown as { row_count?: number }).row_count ?? 0,
            columns: ((t as unknown as { columns?: Array<{ name: string; data_type?: string; type?: string; is_nullable?: boolean; nullable?: boolean; is_pk?: boolean; pk?: boolean }> }).columns ?? []).map((c) => ({
              name: c.name,
              type: c.data_type ?? c.type ?? "text",
              nullable: c.is_nullable ?? c.nullable ?? true,
              pk: c.is_pk ?? c.pk ?? false,
            })),
          }));
        } catch {
          return [];
        }
      }
      await wait();
      return load().tables;
    },

    async listRows(table: string): Promise<Record<string, unknown>[]> {
      if (isLive()) {
        try {
          const res = await live.sql.run(`select * from "${table}" limit 200`, { read_only: true });
          const first = res.results?.[0];
          if (!first) return [];
          return (first.rows as Record<string, unknown>[]) ?? [];
        } catch {
          return [];
        }
      }
      await wait();
      return load().rows[table] ?? [];
    },

    async insertRow(table: string, row: Record<string, unknown>) {
      if (isLive()) {
        const cols = Object.keys(row);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const sql = `insert into "${table}" (${colList}) values (${placeholders}) returning *`;
        const res = await live.sql.run(sql, { params: cols.map((c) => row[c]) });
        return (res.results?.[0]?.rows?.[0] as Record<string, unknown>) ?? { id: rid(), ...row };
      }
      const db = load();
      const r = { id: rid(), ...row };
      db.rows[table] = [r, ...(db.rows[table] ?? [])];
      const t = db.tables.find((x) => x.name === table);
      if (t) t.row_count = (db.rows[table] ?? []).length;
      save(db);
      return r;
    },

    async deleteRow(table: string, id: string) {
      if (isLive()) {
        await live.sql.run(`delete from "${table}" where id = $1`, { params: [id] });
        return;
      }
      const db = load();
      db.rows[table] = (db.rows[table] ?? []).filter((r) => (r.id as string) !== id);
      const t = db.tables.find((x) => x.name === table);
      if (t) t.row_count = (db.rows[table] ?? []).length;
      save(db);
    },

    async runSql(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
      if (isLive()) {
        const res = await live.sql.run(sql);
        return adaptSqlResult(res.results?.[0]);
      }
      await wait();
      return {
        columns: ["statement", "executed_at"],
        rows: [[sql.trim().slice(0, 200), new Date().toISOString()]],
      };
    },
  },

  users: {
    async list(): Promise<PlutoUser[]> {
      if (isLive()) {
        try {
          const items = await live.admin.users.list();
          return items.map(adaptAdminUser);
        } catch {
          return [];
        }
      }
      await wait();
      return load().users;
    },

    async setRole(id: string, role: "admin" | "user") {
      if (isLive()) { await live.admin.users.update(id, { role }); return; }
      const db = load();
      const u = db.users.find((x) => x.id === id);
      if (u) u.role = role;
      save(db);
    },

    async remove(id: string) {
      if (isLive()) { await live.admin.users.remove(id); return; }
      const db = load();
      db.users = db.users.filter((u) => u.id !== id);
      save(db);
    },
  },

  storage: {
    // Note: live storage bucket/object endpoints (/storage/v1/buckets, /objects)
    // are proxied through the same `api()` helper; if the surface ever moves
    // into `live.storage.*`, swap the fetch bodies below for those calls.
    async listBuckets(): Promise<PlutoBucket[]> {
      if (isLive()) {
        try {
          const { api } = await import("./live");
          const rows = await api<Array<{ name: string; public?: boolean; file_count?: number; size_bytes?: number }>>(
            "/storage/v1/buckets",
            { service: true },
          );
          return rows.map((b) => ({
            name: b.name,
            public: !!b.public,
            file_count: b.file_count ?? 0,
            size_bytes: b.size_bytes ?? 0,
          }));
        } catch {
          return [];
        }
      }
      await wait();
      return load().buckets;
    },

    async createBucket(name: string, isPublic: boolean) {
      if (isLive()) {
        const { api } = await import("./live");
        await api("/storage/v1/buckets", {
          method: "POST", service: true,
          body: JSON.stringify({ name, public: isPublic }),
        });
        return;
      }
      const db = load();
      if (db.buckets.some((b) => b.name === name)) throw new Error("এই নামে bucket আছে।");
      db.buckets.push({ name, public: isPublic, file_count: 0, size_bytes: 0 });
      db.files[name] = [];
      save(db);
    },

    async deleteBucket(name: string) {
      if (isLive()) {
        const { api } = await import("./live");
        await api(`/storage/v1/buckets/${encodeURIComponent(name)}`, { method: "DELETE", service: true });
        return;
      }
      const db = load();
      db.buckets = db.buckets.filter((b) => b.name !== name);
      delete db.files[name];
      save(db);
    },

    async listFiles(bucket: string): Promise<PlutoFile[]> {
      if (isLive()) {
        try {
          const { api } = await import("./live");
          const rows = await api<Array<{ key: string; size: number; content_type?: string; updated_at?: string }>>(
            `/storage/v1/list/${encodeURIComponent(bucket)}`,
            { service: true },
          );
          return rows.map((f) => ({
            key: f.key,
            size: f.size,
            content_type: f.content_type ?? "application/octet-stream",
            updated_at: f.updated_at ?? new Date().toISOString(),
          }));
        } catch {
          return [];
        }
      }
      await wait();
      return load().files[bucket] ?? [];
    },

    async upload(bucket: string, file: { name: string; size: number; type: string }) {
      if (isLive()) {
        // Live upload requires the actual Blob/File — this metadata-only
        // signature is a mock legacy. Dashboard upload UI should call
        // live.storage.upload directly with the File.
        return;
      }
      const db = load();
      const f: PlutoFile = { key: file.name, size: file.size, content_type: file.type || "application/octet-stream", updated_at: new Date().toISOString() };
      db.files[bucket] = [f, ...(db.files[bucket] ?? []).filter((x) => x.key !== f.key)];
      const b = db.buckets.find((x) => x.name === bucket);
      if (b) {
        b.file_count = db.files[bucket].length;
        b.size_bytes = db.files[bucket].reduce((s, x) => s + x.size, 0);
      }
      save(db);
    },

    async remove(bucket: string, key: string) {
      if (isLive()) {
        const { api } = await import("./live");
        await api(`/storage/v1/object/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`,
          { method: "DELETE", service: true });
        return;
      }
      const db = load();
      db.files[bucket] = (db.files[bucket] ?? []).filter((f) => f.key !== key);
      const b = db.buckets.find((x) => x.name === bucket);
      if (b) {
        b.file_count = db.files[bucket].length;
        b.size_bytes = db.files[bucket].reduce((s, x) => s + x.size, 0);
      }
      save(db);
    },
  },

  logs: {
    async list(): Promise<PlutoLog[]> {
      if (isLive()) {
        try {
          const items = await live.admin.logs({ limit: 100 });
          return items.map(adaptLog);
        } catch {
          return [];
        }
      }
      await wait();
      return load().logs;
    },
  },

  settings: {
    async get(): Promise<PlutoSettings> {
      if (isLive()) {
        try {
          const { items } = await live.admin.settings.list();
          const map = new Map(items.map((r) => [r.key, r.value]));
          const s = load().settings;
          return {
            backendUrl: (map.get("backend_url") as string) ?? s.backendUrl,
            smtpHost:   (map.get("smtp_host")   as string) ?? s.smtpHost,
            smtpPort:   (map.get("smtp_port")   as number) ?? s.smtpPort,
            smtpUser:   (map.get("smtp_user")   as string) ?? s.smtpUser,
            storageDriver: ((map.get("storage_driver") as "local" | "s3") ?? s.storageDriver),
            s3Bucket:   (map.get("s3_bucket")   as string) ?? s.s3Bucket,
            s3Region:   (map.get("s3_region")   as string) ?? s.s3Region,
            jwtRotatedAt: (map.get("jwt_rotated_at") as string | null) ?? s.jwtRotatedAt,
          };
        } catch {
          return load().settings;
        }
      }
      await wait();
      return load().settings;
    },

    async update(patch: Partial<PlutoSettings>) {
      if (isLive()) {
        const keyMap: Record<keyof PlutoSettings, string> = {
          backendUrl: "backend_url",
          smtpHost: "smtp_host",
          smtpPort: "smtp_port",
          smtpUser: "smtp_user",
          storageDriver: "storage_driver",
          s3Bucket: "s3_bucket",
          s3Region: "s3_region",
          jwtRotatedAt: "jwt_rotated_at",
        };
        for (const [k, v] of Object.entries(patch)) {
          const key = keyMap[k as keyof PlutoSettings];
          if (key) await live.admin.settings.upsert({ key, value: v });
        }
        return;
      }
      const db = load();
      db.settings = { ...db.settings, ...patch };
      save(db);
    },

    async rotateJwt() {
      if (isLive()) {
        await live.admin.settings.upsert({ key: "jwt_rotated_at", value: new Date().toISOString() });
        return;
      }
      const db = load();
      db.settings.jwtRotatedAt = new Date().toISOString();
      save(db);
    },
  },
};
