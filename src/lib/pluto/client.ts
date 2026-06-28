/**
 * @pluto/client (mock implementation)
 *
 * A small, framework-agnostic SDK shim that mirrors the eventual real Pluto
 * BaaS SDK surface. Backed by localStorage so the Admin Dashboard is fully
 * interactive without a running backend. Once the real Pluto Server exists,
 * replace the bodies with fetch calls — the public API stays the same.
 */

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

// ---------- Public API ----------

export const pluto = {
  auth: {
    async signIn(email: string, password: string): Promise<PlutoSession> {
      await wait();
      if (!email || !password) throw new Error("Email এবং password দিন।");
      const db = load();
      let user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (!user) {
        // For the mock dashboard, allow first sign-in as admin.
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
    async signOut() {
      const db = load();
      db.session = null;
      save(db);
    },
    getSession(): PlutoSession | null {
      return load().session;
    },
  },

  db: {
    async listTables(): Promise<PlutoTable[]> {
      await wait();
      return load().tables;
    },
    async listRows(table: string): Promise<Record<string, unknown>[]> {
      await wait();
      return load().rows[table] ?? [];
    },
    async insertRow(table: string, row: Record<string, unknown>) {
      const db = load();
      const r = { id: rid(), ...row };
      db.rows[table] = [r, ...(db.rows[table] ?? [])];
      const t = db.tables.find((x) => x.name === table);
      if (t) t.row_count = (db.rows[table] ?? []).length;
      save(db);
      return r;
    },
    async deleteRow(table: string, id: string) {
      const db = load();
      db.rows[table] = (db.rows[table] ?? []).filter((r) => (r.id as string) !== id);
      const t = db.tables.find((x) => x.name === table);
      if (t) t.row_count = (db.rows[table] ?? []).length;
      save(db);
    },
    async runSql(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
      await wait();
      // Mock: just echo back the parsed-ish statement.
      return {
        columns: ["statement", "executed_at"],
        rows: [[sql.trim().slice(0, 200), new Date().toISOString()]],
      };
    },
  },

  users: {
    async list(): Promise<PlutoUser[]> {
      await wait();
      return load().users;
    },
    async setRole(id: string, role: "admin" | "user") {
      const db = load();
      const u = db.users.find((x) => x.id === id);
      if (u) u.role = role;
      save(db);
    },
    async remove(id: string) {
      const db = load();
      db.users = db.users.filter((u) => u.id !== id);
      save(db);
    },
  },

  storage: {
    async listBuckets(): Promise<PlutoBucket[]> {
      await wait();
      return load().buckets;
    },
    async createBucket(name: string, isPublic: boolean) {
      const db = load();
      if (db.buckets.some((b) => b.name === name)) throw new Error("এই নামে bucket আছে।");
      db.buckets.push({ name, public: isPublic, file_count: 0, size_bytes: 0 });
      db.files[name] = [];
      save(db);
    },
    async deleteBucket(name: string) {
      const db = load();
      db.buckets = db.buckets.filter((b) => b.name !== name);
      delete db.files[name];
      save(db);
    },
    async listFiles(bucket: string): Promise<PlutoFile[]> {
      await wait();
      return load().files[bucket] ?? [];
    },
    async upload(bucket: string, file: { name: string; size: number; type: string }) {
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
      await wait();
      return load().logs;
    },
  },

  settings: {
    async get(): Promise<PlutoSettings> {
      await wait();
      return load().settings;
    },
    async update(patch: Partial<PlutoSettings>) {
      const db = load();
      db.settings = { ...db.settings, ...patch };
      save(db);
    },
    async rotateJwt() {
      const db = load();
      db.settings.jwtRotatedAt = new Date().toISOString();
      save(db);
    },
  },
};
