import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';

// Introspect a project's tables → produce a minimal GraphQL SDL and a simple
// executor that maps queries to REST-like SQL. This is a lean pg_graphql
// alternative: Query only, one selection per table, plus a health field.

type Col = { name: string; type: string; nullable: boolean; is_pk: boolean };
type Tbl = { schema: string; name: string; cols: Col[] };

async function introspect(sql: any, schemas: string[]): Promise<Tbl[]> {
  const rows = await sql`
    select c.table_schema, c.table_name, c.column_name, c.udt_name,
           c.is_nullable = 'YES' as nullable,
           coalesce(k.is_pk, false) as is_pk
      from information_schema.columns c
      left join lateral (
        select true as is_pk
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on tc.constraint_name = kcu.constraint_name
         where tc.constraint_type = 'PRIMARY KEY'
           and tc.table_schema = c.table_schema
           and tc.table_name   = c.table_name
           and kcu.column_name = c.column_name
      ) k on true
     where c.table_schema = any(${schemas})
     order by c.table_schema, c.table_name, c.ordinal_position`;
  const map = new Map<string, Tbl>();
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!map.has(key)) map.set(key, { schema: r.table_schema, name: r.table_name, cols: [] });
    map.get(key)!.cols.push({
      name: r.column_name, type: r.udt_name, nullable: r.nullable, is_pk: r.is_pk,
    });
  }
  return [...map.values()];
}

function pgToGql(t: string): string {
  if (['int2', 'int4', 'int8'].includes(t)) return 'Int';
  if (['float4', 'float8', 'numeric'].includes(t)) return 'Float';
  if (t === 'bool') return 'Boolean';
  if (t === 'jsonb' || t === 'json') return 'JSON';
  return 'String';
}

function toTypeName(schema: string, name: string) {
  const parts = (schema === 'public' ? name : `${schema}_${name}`)
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return parts.join('');
}

function buildSdl(tables: Tbl[]): string {
  const types: string[] = ['scalar JSON', 'type Health { ok: Boolean!, service: String! }'];
  const queries: string[] = ['health: Health!'];
  for (const t of tables) {
    const tn = toTypeName(t.schema, t.name);
    const fields = t.cols
      .map((c) => `  ${c.name}: ${pgToGql(c.type)}${!c.nullable ? '!' : ''}`)
      .join('\n');
    types.push(`type ${tn} {\n${fields}\n}`);
    queries.push(
      `${t.name}(limit: Int = 20, offset: Int = 0, orderBy: String): [${tn}!]!`,
      `${t.name}_by_id(id: String!): ${tn}`,
    );
  }
  return `${types.join('\n\n')}\n\ntype Query {\n  ${queries.join('\n  ')}\n}\n`;
}

// Very small query parser: extract `queryName(args)` and its selection set.
// Real projects should swap this for `graphql` package's `parse/execute`.
function parseSimple(query: string): { field: string; args: Record<string, any>; selection: string[] } | null {
  const m = query.match(/\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]*)\))?\s*\{([^}]+)\}/);
  if (!m) return null;
  const args: Record<string, any> = {};
  if (m[2]) {
    for (const pair of m[2].split(',')) {
      const [k, v] = pair.split(':').map((s) => s.trim());
      if (!k) continue;
      const raw = v.replace(/^"|"$/g, '');
      args[k] = /^-?\d+$/.test(raw) ? parseInt(raw) : raw;
    }
  }
  const selection = m[3].split(/\s+/).filter(Boolean);
  return { field: m[1], args, selection };
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export async function graphqlRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/admin/v1/graphql/config', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    const sql = getSql(cfg);
    const [row] = await sql`select * from admin.graphql_configs where project_id = ${q.project_id}`;
    return row ?? null;
  });

  app.post('/admin/v1/graphql/enable', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = z.object({
      project_id: z.string().uuid(),
      schemas: z.array(z.string()).min(1).default(['public']),
      enable_subs: z.boolean().default(false),
    }).parse(req.body);
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);
    const tables = await introspect(sql, b.schemas);
    const sdl = buildSdl(tables);
    const [row] = await sql`
      insert into admin.graphql_configs (project_id, schemas, enable_subs, cached_sdl)
      values (${b.project_id}, ${b.schemas}, ${b.enable_subs}, ${sdl})
      on conflict (project_id)
      do update set schemas = excluded.schemas,
                    enable_subs = excluded.enable_subs,
                    cached_sdl = excluded.cached_sdl,
                    updated_at = now()
      returning *`;
    return row;
  });

  app.get('/admin/v1/graphql/sdl', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    const sql = getSql(cfg);
    const [row] = await sql`select cached_sdl from admin.graphql_configs where project_id = ${q.project_id}`;
    return { sdl: row?.cached_sdl ?? '' };
  });

  // Execute a query
  app.post('/graphql/v1/:project_id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { project_id } = z.object({ project_id: z.string().uuid() }).parse(req.params);
    await requireProjectRole(cfg, project_id, actor, ['owner', 'admin', 'member']);
    const body = z.object({ query: z.string(), variables: z.record(z.any()).optional() }).parse(req.body);
    const sql = getSql(cfg);
    const [cfgRow] = await sql`select * from admin.graphql_configs where project_id = ${project_id}`;
    if (!cfgRow) return reply.code(400).send({ errors: [{ message: 'GraphQL not enabled' }] });

    const parsed = parseSimple(body.query);
    if (!parsed) return { errors: [{ message: 'unsupported query shape (this executor is minimal)' }] };

    if (parsed.field === 'health') return { data: { health: { ok: true, service: 'pluto-graphql' } } };

    const tables = await introspect(sql, cfgRow.schemas);
    const byId = parsed.field.endsWith('_by_id');
    const tableName = byId ? parsed.field.replace(/_by_id$/, '') : parsed.field;
    const t = tables.find((x) => x.name === tableName);
    if (!t) return { errors: [{ message: `unknown field: ${parsed.field}` }] };

    if (!IDENT.test(t.schema) || !IDENT.test(t.name)) {
      return { errors: [{ message: 'invalid identifier' }] };
    }
    const cols = parsed.selection.filter((c) => t.cols.some((tc) => tc.name === c));
    if (cols.length === 0) return { errors: [{ message: 'no valid columns selected' }] };
    const projection = cols.map((c) => `"${c}"`).join(', ');

    let rows: any[];
    if (byId) {
      const pk = t.cols.find((c) => c.is_pk)?.name ?? 'id';
      rows = await sql.unsafe(
        `select ${projection} from "${t.schema}"."${t.name}" where "${pk}" = $1 limit 1`,
        [parsed.args.id],
      );
      return { data: { [parsed.field]: rows[0] ?? null } };
    }

    const limit = Math.min(200, parseInt(parsed.args.limit ?? '20'));
    const offset = Math.max(0, parseInt(parsed.args.offset ?? '0'));
    let order = '';
    if (parsed.args.orderBy && IDENT.test(parsed.args.orderBy)) {
      order = `order by "${parsed.args.orderBy}"`;
    }
    rows = await sql.unsafe(
      `select ${projection} from "${t.schema}"."${t.name}" ${order} limit $1 offset $2`,
      [limit, offset],
    );
    return { data: { [parsed.field]: rows } };
  });
}
