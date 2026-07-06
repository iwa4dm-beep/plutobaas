/**
 * @pluto/client — adapter SDK (live-only)
 *
 * Every method routes to the real Pluto backend via `./live`, which itself
 * goes through the same-origin `/api/pluto` proxy. There is no mock or
 * demo fallback — if the backend is unreachable, the call throws and
 * callers must render a real error state.
 *
 * Adding a new method? Wrap the corresponding `live.*` call and map the
 * response into the stable public shape defined in this module.
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

// ---------- Guards ----------

function ensureLive(): void {
  if (!isLive()) {
    throw new Error(
      "Pluto backend not configured. Set VITE_PLUTO_URL and VITE_PLUTO_ANON_KEY (or use the default same-origin /api/pluto proxy).",
    );
  }
}

// ---------- Adapters (live → public shape) ----------

function adaptAuthUser(u: { id: string; email: string; role?: string; email_verified?: boolean; created_at?: string; is_superadmin?: boolean; email_confirmed_at?: string | null }): PlutoUser {
  return {
    id: u.id,
    email: u.email,
    role: u.is_superadmin || u.role === "admin" ? "admin" : "user",
    email_verified: u.email_verified ?? Boolean(u.email_confirmed_at),
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

/** SqlResult → `{ columns, rows }` used by the SQL editor. */
function adaptSqlResult(res: SqlResult | undefined): { columns: string[]; rows: unknown[][] } {
  if (!res) return { columns: [], rows: [] };
  const columns = res.columns.map((c) => c.name);
  const rows = (res.rows as Record<string, unknown>[]).map((r) => columns.map((c) => r[c]));
  return { columns, rows };
}

const DEFAULT_SETTINGS: PlutoSettings = {
  backendUrl: "",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  storageDriver: "local",
  s3Bucket: "",
  s3Region: "",
  jwtRotatedAt: null,
};

// ---------- Public API ----------

export const pluto = {
  /** Always true now — kept for backwards compatibility with existing callers. */
  isLive: () => isLive(),

  auth: {
    async signIn(email: string, password: string): Promise<PlutoSession> {
      if (!email || !password) throw new Error("Email এবং password দিন।");
      ensureLive();
      const r = await live.auth.signIn(email, password);
      return {
        access_token: r.session.access_token,
        refresh_token: r.session.refresh_token,
        expires_at: r.session.expires_at,
        user: adaptAuthUser(r.user),
      };
    },

    async signUp(email: string, password: string): Promise<PlutoSession> {
      ensureLive();
      const r = await live.auth.signUp(email, password);
      return {
        access_token: r.session.access_token,
        refresh_token: r.session.refresh_token,
        expires_at: r.session.expires_at,
        user: adaptAuthUser(r.user),
      };
    },

    async signOut() {
      ensureLive();
      await live.auth.signOut();
    },

    getSession(): PlutoSession | null {
      if (!isLive()) return null;
      const s = live.auth.session();
      if (!s || !s.user) return null;
      return {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at,
        user: adaptAuthUser(s.user),
      };
    },
  },

  db: {
    async listTables(): Promise<PlutoTable[]> {
      ensureLive();
      const { tables } = await live.schema.introspect();
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
    },

    async listRows(table: string): Promise<Record<string, unknown>[]> {
      ensureLive();
      const res = await live.sql.run(`select * from "${table}" limit 200`, { read_only: true });
      const first = res.results?.[0];
      if (!first) return [];
      return (first.rows as Record<string, unknown>[]) ?? [];
    },

    async insertRow(table: string, row: Record<string, unknown>) {
      ensureLive();
      const cols = Object.keys(row);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const colList = cols.map((c) => `"${c}"`).join(", ");
      const sql = `insert into "${table}" (${colList}) values (${placeholders}) returning *`;
      const res = await live.sql.run(sql, { params: cols.map((c) => row[c]) });
      return (res.results?.[0]?.rows?.[0] as Record<string, unknown>) ?? row;
    },

    async deleteRow(table: string, id: string) {
      ensureLive();
      await live.sql.run(`delete from "${table}" where id = $1`, { params: [id] });
    },

    async runSql(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
      ensureLive();
      const res = await live.sql.run(sql);
      return adaptSqlResult(res.results?.[0]);
    },

    async updateRow(table: string, id: string, patch: Record<string, unknown>) {
      ensureLive();
      const cols = Object.keys(patch);
      if (!cols.length) return;
      const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
      const sql = `update "${table}" set ${sets} where id = $${cols.length + 1}`;
      await live.sql.run(sql, { params: [...cols.map((c) => patch[c]), id] });
    },

    async createTable(name: string, columns: Array<{ name: string; type: string; nullable?: boolean; pk?: boolean }>) {
      ensureLive();
      const defs = columns.map((c) => {
        const parts = [`"${c.name}"`, c.type];
        if (c.pk) parts.push("primary key");
        if (!c.nullable && !c.pk) parts.push("not null");
        return parts.join(" ");
      }).join(", ");
      await live.sql.run(`create table "${name}" (${defs})`);
    },

    async dropTable(name: string) {
      ensureLive();
      await live.sql.run(`drop table if exists "${name}" cascade`);
    },

    async addColumn(table: string, col: { name: string; type: string; nullable?: boolean }) {
      ensureLive();
      const sql = `alter table "${table}" add column "${col.name}" ${col.type}${col.nullable === false ? " not null" : ""}`;
      await live.sql.run(sql);
    },

    async dropColumn(table: string, column: string) {
      ensureLive();
      await live.sql.run(`alter table "${table}" drop column "${column}"`);
    },

    async importRows(table: string, rows: Record<string, unknown>[]) {
      if (!rows.length) return { inserted: 0 };
      ensureLive();
      let inserted = 0;
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        const cols = Object.keys(chunk[0]);
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const params: unknown[] = [];
        const valuesSql = chunk.map((row) => {
          const placeholders = cols.map((c) => { params.push(row[c]); return `$${params.length}`; }).join(", ");
          return `(${placeholders})`;
        }).join(", ");
        await live.sql.run(`insert into "${table}" (${colList}) values ${valuesSql}`, { params });
        inserted += chunk.length;
      }
      return { inserted };
    },
  },

  users: {
    async list(): Promise<PlutoUser[]> {
      ensureLive();
      const items = await live.admin.users.list();
      return items.map(adaptAdminUser);
    },

    async setRole(id: string, role: "admin" | "user") {
      ensureLive();
      await live.admin.users.update(id, { role });
    },

    async remove(id: string) {
      ensureLive();
      await live.admin.users.remove(id);
    },
  },

  storage: {
    async listBuckets(): Promise<PlutoBucket[]> {
      ensureLive();
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
    },

    async createBucket(name: string, isPublic: boolean) {
      ensureLive();
      const { api } = await import("./live");
      await api("/storage/v1/buckets", {
        method: "POST", service: true,
        body: JSON.stringify({ name, public: isPublic }),
      });
    },

    async deleteBucket(name: string) {
      ensureLive();
      const { api } = await import("./live");
      await api(`/storage/v1/buckets/${encodeURIComponent(name)}`, { method: "DELETE", service: true });
    },

    async listFiles(bucket: string): Promise<PlutoFile[]> {
      ensureLive();
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
    },

    async upload(_bucket: string, _file: { name: string; size: number; type: string }) {
      // Metadata-only signature is deprecated. UI must call live.storage.upload
      // directly with the real File/Blob object.
      throw new Error("pluto.storage.upload requires a File/Blob — use live.storage.upload directly.");
    },

    async remove(bucket: string, key: string) {
      ensureLive();
      const { api } = await import("./live");
      await api(`/storage/v1/object/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`,
        { method: "DELETE", service: true });
    },
  },

  logs: {
    async list(): Promise<PlutoLog[]> {
      ensureLive();
      const items = await live.admin.logs({ limit: 100 });
      return items.map(adaptLog);
    },
  },

  settings: {
    async get(): Promise<PlutoSettings> {
      ensureLive();
      const { items } = await live.admin.settings.list();
      const map = new Map(items.map((r) => [r.key, r.value]));
      return {
        backendUrl: (map.get("backend_url") as string) ?? DEFAULT_SETTINGS.backendUrl,
        smtpHost:   (map.get("smtp_host")   as string) ?? DEFAULT_SETTINGS.smtpHost,
        smtpPort:   (map.get("smtp_port")   as number) ?? DEFAULT_SETTINGS.smtpPort,
        smtpUser:   (map.get("smtp_user")   as string) ?? DEFAULT_SETTINGS.smtpUser,
        storageDriver: ((map.get("storage_driver") as "local" | "s3") ?? DEFAULT_SETTINGS.storageDriver),
        s3Bucket:   (map.get("s3_bucket")   as string) ?? DEFAULT_SETTINGS.s3Bucket,
        s3Region:   (map.get("s3_region")   as string) ?? DEFAULT_SETTINGS.s3Region,
        jwtRotatedAt: (map.get("jwt_rotated_at") as string | null) ?? DEFAULT_SETTINGS.jwtRotatedAt,
      };
    },

    async update(patch: Partial<PlutoSettings>) {
      ensureLive();
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
    },

    async rotateJwt() {
      ensureLive();
      await live.admin.settings.upsert({ key: "jwt_rotated_at", value: new Date().toISOString() });
    },
  },
};
