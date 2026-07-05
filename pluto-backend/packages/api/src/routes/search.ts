import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const asIdent = (s: string) => {
  if (!IDENT.test(s)) throw Object.assign(new Error(`invalid identifier: ${s}`), { statusCode: 400 });
  return `"${s}"`;
};

// ---------- FTS ----------
const ftsEnableBody = z.object({
  project_id: z.string().uuid(),
  schema: z.string(), table: z.string(), column: z.string(),
  tsv_column: z.string().default('search_tsv'),
  language: z.string().default('english'),
});

const ftsQueryBody = z.object({
  project_id: z.string().uuid(),
  schema: z.string(), table: z.string(),
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(200).default(20),
});

// ---------- Vector ----------
const vecEnableBody = z.object({
  project_id: z.string().uuid(),
  schema: z.string(), table: z.string(), column: z.string(),
  dimensions: z.number().int().min(1).max(4096),
  metric: z.enum(['cosine', 'l2', 'ip']).default('cosine'),
  index_kind: z.enum(['ivfflat', 'hnsw', 'none']).default('ivfflat'),
});

const vecQueryBody = z.object({
  project_id: z.string().uuid(),
  schema: z.string(), table: z.string(), column: z.string(),
  vector: z.array(z.number()).min(1),
  metric: z.enum(['cosine', 'l2', 'ip']).default('cosine'),
  limit: z.number().int().min(1).max(200).default(10),
});

export async function searchRoutes(app: FastifyInstance, cfg: Config) {
  // ==== FTS ====
  app.get('/admin/v1/search/fts', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    return getSql(cfg)`
      select * from admin.search_configs where project_id = ${q.project_id} order by created_at desc`;
  });

  app.post('/admin/v1/search/fts/enable', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = ftsEnableBody.parse(req.body);
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);
    const S = asIdent(b.schema), T = asIdent(b.table), C = asIdent(b.column), TSV = asIdent(b.tsv_column);
    const lang = b.language.replace(/[^a-z_]/gi, '');
    // Add generated tsvector column and GIN index
    await sql.unsafe(`
      alter table ${S}.${T}
        add column if not exists ${TSV} tsvector
        generated always as (to_tsvector('${lang}', coalesce(${C}::text, ''))) stored;
      create index if not exists ${asIdent(`${b.table}_${b.tsv_column}_gin`)}
        on ${S}.${T} using gin (${TSV});
    `);
    const [row] = await sql`
      insert into admin.search_configs (project_id, schema_name, table_name, column_name, tsv_column, language)
      values (${b.project_id}, ${b.schema}, ${b.table}, ${b.column}, ${b.tsv_column}, ${b.language})
      on conflict (project_id, schema_name, table_name, column_name)
      do update set tsv_column = excluded.tsv_column, language = excluded.language
      returning *`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: b.project_id,
      action: 'search.fts.enable', resource_type: 'table',
      resource_id: `${b.schema}.${b.table}`, params: b,
    });
    return row;
  });

  app.post('/admin/v1/search/fts/query', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = ftsQueryBody.parse(req.body);
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin', 'member']);
    const sql = getSql(cfg);
    const [conf] = await sql`
      select * from admin.search_configs
       where project_id = ${b.project_id} and schema_name = ${b.schema} and table_name = ${b.table}
       limit 1`;
    if (!conf) throw Object.assign(new Error('FTS not enabled for this table'), { statusCode: 400 });
    const S = asIdent(b.schema), T = asIdent(b.table), TSV = asIdent(conf.tsv_column);
    const rows = await sql.unsafe(
      `select *, ts_rank(${TSV}, plainto_tsquery('${conf.language}', $1)) as rank
         from ${S}.${T}
        where ${TSV} @@ plainto_tsquery('${conf.language}', $1)
        order by rank desc
        limit $2`,
      [b.query, b.limit],
    );
    return rows;
  });

  // ==== VECTOR ====
  app.get('/admin/v1/search/vector', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    return getSql(cfg)`
      select * from admin.vector_configs where project_id = ${q.project_id} order by created_at desc`;
  });

  app.post('/admin/v1/search/vector/enable', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = vecEnableBody.parse(req.body);
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);

    const has = await sql`select 1 from pg_extension where extname = 'vector'`;
    if (has.length === 0) {
      throw Object.assign(new Error('pgvector extension not installed on this database'), { statusCode: 400 });
    }

    const S = asIdent(b.schema), T = asIdent(b.table), C = asIdent(b.column);
    await sql.unsafe(`alter table ${S}.${T} add column if not exists ${C} vector(${b.dimensions});`);

    if (b.index_kind !== 'none') {
      const ops = b.metric === 'cosine' ? 'vector_cosine_ops'
                : b.metric === 'l2'     ? 'vector_l2_ops'
                                        : 'vector_ip_ops';
      const idxName = asIdent(`${b.table}_${b.column}_${b.index_kind}`);
      const suffix = b.index_kind === 'ivfflat' ? ' with (lists = 100)' : '';
      await sql.unsafe(
        `create index if not exists ${idxName} on ${S}.${T} using ${b.index_kind} (${C} ${ops})${suffix};`,
      );
    }

    const [row] = await sql`
      insert into admin.vector_configs
        (project_id, schema_name, table_name, column_name, dimensions, metric, index_kind)
      values (${b.project_id}, ${b.schema}, ${b.table}, ${b.column},
              ${b.dimensions}, ${b.metric}, ${b.index_kind})
      on conflict (project_id, schema_name, table_name, column_name)
      do update set metric = excluded.metric, index_kind = excluded.index_kind
      returning *`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: b.project_id,
      action: 'search.vector.enable', resource_type: 'table',
      resource_id: `${b.schema}.${b.table}`, params: b,
    });
    return row;
  });

  app.post('/admin/v1/search/vector/query', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = vecQueryBody.parse(req.body);
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin', 'member']);
    const sql = getSql(cfg);
    const S = asIdent(b.schema), T = asIdent(b.table), C = asIdent(b.column);
    const op = b.metric === 'cosine' ? '<=>' : b.metric === 'l2' ? '<->' : '<#>';
    const vec = `[${b.vector.join(',')}]`;
    const rows = await sql.unsafe(
      `select *, ${C} ${op} $1::vector as distance
         from ${S}.${T}
        where ${C} is not null
        order by ${C} ${op} $1::vector
        limit $2`,
      [vec, b.limit],
    );
    return rows;
  });
}
