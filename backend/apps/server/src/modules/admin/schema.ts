// Auto-generated REST API descriptor.
//
// Introspects the `public` schema and returns:
//   GET /admin/v1/schema                → machine-readable schema (tables, cols, pk, fk)
//   GET /admin/v1/schema/openapi.json   → OpenAPI 3.1 doc mirroring the /rest/v1 surface
//
// Anon-key holders (frontends) can hit /schema (read-only) so an SDK can
// discover the endpoints available to them. Every table under `public.`
// that has been GRANTed to `authenticated` or `anon` is auto-exposed by
// the REST engine (modules/rest/routes.ts) — the OpenAPI doc reflects that.

import type { FastifyInstance } from "fastify";
import pg from "pg";
import { env } from "../../config.js";
import { requireApiKey } from "../../lib/apikey.js";

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

type Column = {
  name: string;
  data_type: string;
  udt_name: string;
  is_nullable: boolean;
  has_default: boolean;
  is_primary_key: boolean;
  is_unique: boolean;
  references: { table: string; column: string } | null;
};
type Table = {
  schema: string;
  name: string;
  comment: string | null;
  columns: Column[];
  primary_key: string[];
  rls_enabled: boolean;
  policies: string[];
  workspace_scoped: boolean;
  privileges: { anon: string[]; authenticated: string[]; service_role: string[] };
};

async function introspect(): Promise<Table[]> {
  const { rows: tables } = await pool.query<{ schema: string; name: string; comment: string | null; rls: boolean }>(`
    select n.nspname            as schema,
           c.relname            as name,
           d.description        as comment,
           c.relrowsecurity     as rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
 left join pg_description d on d.objoid = c.oid and d.objsubid = 0
     where c.relkind = 'r' and n.nspname = 'public'
     order by c.relname
  `);

  const { rows: cols } = await pool.query<{
    table_name: string; column_name: string; data_type: string; udt_name: string;
    is_nullable: string; column_default: string | null; ordinal_position: number;
  }>(`
    select table_name, column_name, data_type, udt_name, is_nullable,
           column_default, ordinal_position
      from information_schema.columns
     where table_schema = 'public'
     order by table_name, ordinal_position
  `);

  const { rows: pks } = await pool.query<{ table_name: string; column_name: string }>(`
    select tc.table_name, kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
     where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY'
  `);
  const pkMap = new Map<string, Set<string>>();
  for (const r of pks) {
    if (!pkMap.has(r.table_name)) pkMap.set(r.table_name, new Set());
    pkMap.get(r.table_name)!.add(r.column_name);
  }

  const { rows: fks } = await pool.query<{
    table_name: string; column_name: string; foreign_table: string; foreign_column: string;
  }>(`
    select kcu.table_name, kcu.column_name,
           ccu.table_name  as foreign_table,
           ccu.column_name as foreign_column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
     where tc.table_schema = 'public' and tc.constraint_type = 'FOREIGN KEY'
  `);
  const fkMap = new Map<string, { table: string; column: string }>();
  for (const r of fks) fkMap.set(`${r.table_name}.${r.column_name}`, { table: r.foreign_table, column: r.foreign_column });

  const { rows: uniques } = await pool.query<{ table_name: string; column_name: string }>(`
    select kcu.table_name, kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
     where tc.table_schema = 'public' and tc.constraint_type = 'UNIQUE'
  `);
  const uniqSet = new Set(uniques.map((u) => `${u.table_name}.${u.column_name}`));

  const { rows: policies } = await pool.query<{ tablename: string; polname: string }>(`
    select c.relname as tablename, p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
  `);
  const polMap = new Map<string, string[]>();
  for (const p of policies) {
    if (!polMap.has(p.tablename)) polMap.set(p.tablename, []);
    polMap.get(p.tablename)!.push(p.polname);
  }

  const { rows: grants } = await pool.query<{ table_name: string; grantee: string; privilege_type: string }>(`
    select table_name, grantee, privilege_type
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee in ('anon','authenticated','service_role')
  `);
  const grantMap = new Map<string, { anon: Set<string>; authenticated: Set<string>; service_role: Set<string> }>();
  for (const g of grants) {
    if (!grantMap.has(g.table_name)) grantMap.set(g.table_name, { anon: new Set(), authenticated: new Set(), service_role: new Set() });
    const bag = grantMap.get(g.table_name)!;
    (bag[g.grantee as "anon" | "authenticated" | "service_role"]).add(g.privilege_type);
  }

  const out: Table[] = tables.map((t) => {
    const tableCols = cols.filter((c) => c.table_name === t.name);
    const pk = pkMap.get(t.name) ?? new Set<string>();
    const columns: Column[] = tableCols.map((c) => ({
      name: c.column_name,
      data_type: c.data_type,
      udt_name: c.udt_name,
      is_nullable: c.is_nullable === "YES",
      has_default: c.column_default != null,
      is_primary_key: pk.has(c.column_name),
      is_unique: uniqSet.has(`${t.name}.${c.column_name}`),
      references: fkMap.get(`${t.name}.${c.column_name}`) ?? null,
    }));
    const g = grantMap.get(t.name);
    return {
      schema: t.schema,
      name: t.name,
      comment: t.comment,
      columns,
      primary_key: [...pk],
      rls_enabled: t.rls,
      policies: polMap.get(t.name) ?? [],
      workspace_scoped: columns.some((c) => c.name === "workspace_id"),
      privileges: {
        anon: g ? [...g.anon] : [],
        authenticated: g ? [...g.authenticated] : [],
        service_role: g ? [...g.service_role] : [],
      },
    };
  });
  return out;
}

// Map postgres udt → OpenAPI JSON schema fragment.
function pgToSchema(udt: string): Record<string, unknown> {
  switch (udt) {
    case "uuid": return { type: "string", format: "uuid" };
    case "text": case "varchar": case "bpchar": case "citext": return { type: "string" };
    case "int2": case "int4": return { type: "integer" };
    case "int8": return { type: "integer", format: "int64" };
    case "float4": case "float8": case "numeric": return { type: "number" };
    case "bool": return { type: "boolean" };
    case "timestamp": case "timestamptz": return { type: "string", format: "date-time" };
    case "date": return { type: "string", format: "date" };
    case "jsonb": case "json": return { type: "object", additionalProperties: true };
    default: return { type: "string" };
  }
}

function buildOpenApi(tables: Table[], baseUrl: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const t of tables) {
    // Skip tables the SDK cannot legitimately reach (no grants at all).
    const reachable = t.privileges.anon.length + t.privileges.authenticated.length > 0;
    if (!reachable) continue;
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const c of t.columns) {
      const s = pgToSchema(c.udt_name);
      if (c.is_nullable) (s as { nullable?: boolean }).nullable = true;
      props[c.name] = s;
      if (!c.is_nullable && !c.has_default) required.push(c.name);
    }
    schemas[t.name] = { type: "object", properties: props, required, "x-pluto-workspace-scoped": t.workspace_scoped };
    const ref = { $ref: `#/components/schemas/${t.name}` };
    paths[`/rest/v1/${t.name}`] = {
      get: {
        summary: `List rows from ${t.name}`,
        parameters: [
          { name: "select", in: "query", schema: { type: "string" } },
          { name: "order",  in: "query", schema: { type: "string" } },
          { name: "limit",  in: "query", schema: { type: "integer", maximum: 1000 } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "array", items: ref } } } } },
      },
      post:  { summary: `Insert rows into ${t.name}`,   requestBody: { content: { "application/json": { schema: { oneOf: [ref, { type: "array", items: ref }] } } } }, responses: { "201": { description: "Created" } } },
      patch: { summary: `Update rows in ${t.name}`,     requestBody: { content: { "application/json": { schema: ref } } }, responses: { "200": { description: "OK" } } },
      delete:{ summary: `Delete rows from ${t.name}`,   responses: { "200": { description: "OK" } } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Pluto auto REST", version: "1.0.0", description: "Auto-generated from the public schema. Filters follow PostgREST syntax (?col=eq.x, ?col=in.(a,b), ?col=is.null)." },
    servers: [{ url: baseUrl }],
    components: {
      schemas,
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "apikey" },
        bearer: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ apiKey: [], bearer: [] }],
    paths,
  };
}

export async function schemaRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  app.get("/", async () => ({ tables: await introspect() }));

  app.get("/openapi.json", async (req) => {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
    const host = req.headers.host ?? "localhost";
    return buildOpenApi(await introspect(), `${proto}://${host}`);
  });

  // Convenience: return only tables the caller can actually SELECT under RLS.
  app.get("/summary", async (req) => {
    const tables = await introspect();
    const isService = req.auth?.apiKey === "service_role";
    const role = isService ? "service_role" : "authenticated";
    return {
      workspace_id: req.auth?.workspaceId ?? null,
      role,
      endpoints: tables
        .filter((t) => isService || t.privileges.authenticated.length + t.privileges.anon.length > 0)
        .map((t) => ({
          table: t.name,
          workspace_scoped: t.workspace_scoped,
          rls_enabled: t.rls_enabled,
          primary_key: t.primary_key,
          columns: t.columns.map((c) => c.name),
          methods: ["GET", "POST", "PATCH", "DELETE"],
          base: `/rest/v1/${t.name}`,
        })),
    };
  });
}
