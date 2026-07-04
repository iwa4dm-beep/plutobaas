// Schema introspection: reads information_schema and caches a snapshot
// used by the OpenAPI + GraphQL adapters.
import { q } from "../../../lib/pgraw.js";

export type ColumnInfo = {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_pk: boolean;
};
export type TableInfo = {
  schema: string;
  name: string;
  columns: ColumnInfo[];
};
export type SchemaSnapshot = {
  tables: TableInfo[];
  refreshed_at: string;
};

let cache: { snapshot: SchemaSnapshot; expires: number } | null = null;
const TTL_MS = 60_000;

const HIDDEN_TABLES = new Set([
  "users", "refresh_tokens", "buckets", "objects", "oauth_accounts",
  "billing_plans", "billing_subscriptions", "billing_events",
  "wal_archive_config", "pitr_snapshots", "backup_replicas", "pitr_restores",
  "fn_secrets", "fn_v3_deployments", "fn_v3_invocations",
  "data_api_exposed", "data_api_introspect_cache",
  "cdc_config", "cdc_events", "render_cache", "tus_uploads",
  "password_reset_tokens", "phone_otp_codes",
]);

export async function getSchemaSnapshot(force = false): Promise<SchemaSnapshot> {
  const now = Date.now();
  if (!force && cache && cache.expires > now) return cache.snapshot;

  const tables = await q<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`,
  );
  const cols = await q<{
    table_name: string; column_name: string; data_type: string; is_nullable: string;
  }>(
    `select table_name, column_name, data_type, is_nullable
     from information_schema.columns where table_schema = 'public'
     order by table_name, ordinal_position`,
  );
  const pks = await q<{ table_name: string; column_name: string }>(
    `select kcu.table_name, kcu.column_name
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on tc.constraint_name = kcu.constraint_name
      and tc.table_schema   = kcu.table_schema
     where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'`,
  );
  const pkMap = new Map<string, Set<string>>();
  for (const r of pks.rows) {
    if (!pkMap.has(r.table_name)) pkMap.set(r.table_name, new Set());
    pkMap.get(r.table_name)!.add(r.column_name);
  }
  const byTable = new Map<string, ColumnInfo[]>();
  for (const c of cols.rows) {
    const pk = pkMap.get(c.table_name)?.has(c.column_name) ?? false;
    const arr = byTable.get(c.table_name) ?? [];
    arr.push({ name: c.column_name, data_type: c.data_type,
               is_nullable: c.is_nullable === "YES", is_pk: pk });
    byTable.set(c.table_name, arr);
  }
  const out: TableInfo[] = [];
  for (const t of tables.rows) {
    if (HIDDEN_TABLES.has(t.table_name)) continue;
    out.push({ schema: t.table_schema, name: t.table_name,
               columns: byTable.get(t.table_name) ?? [] });
  }
  const snapshot: SchemaSnapshot = { tables: out, refreshed_at: new Date().toISOString() };
  cache = { snapshot, expires: now + TTL_MS };
  return snapshot;
}

export function invalidateSchemaCache(): void { cache = null; }

const PG_TO_OPENAPI: Record<string, { type: string; format?: string }> = {
  "uuid": { type: "string", format: "uuid" },
  "text": { type: "string" },
  "character varying": { type: "string" },
  "integer": { type: "integer" },
  "bigint": { type: "integer", format: "int64" },
  "smallint": { type: "integer" },
  "boolean": { type: "boolean" },
  "numeric": { type: "number" },
  "real": { type: "number" }, "double precision": { type: "number" },
  "jsonb": { type: "object" }, "json": { type: "object" },
  "timestamp with time zone": { type: "string", format: "date-time" },
  "timestamp without time zone": { type: "string", format: "date-time" },
  "date": { type: "string", format: "date" },
};

export function columnToOpenApi(c: ColumnInfo): Record<string, unknown> {
  return { ...(PG_TO_OPENAPI[c.data_type] ?? { type: "string" }),
           nullable: c.is_nullable };
}
