// AI Gateway: unified LLM/embeddings proxy with per-project keys, prompt logs,
// cost tracking, and embedding jobs that populate pgvector columns (defined
// via search.ts vector_configs — no vector storage duplicated here).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

// Rough token→USD price map (USD per 1K tokens). Extend as needed.
const PRICE: Record<string, { in: number; out: number }> = {
  'google/gemini-embedding-001': { in: 0.00013, out: 0 },
  'openai/text-embedding-3-small': { in: 0.00002, out: 0 },
  'openai/text-embedding-3-large': { in: 0.00013, out: 0 },
  'google/gemini-2.5-flash': { in: 0.000075, out: 0.0003 },
  'openai/gpt-5-mini': { in: 0.00015, out: 0.0006 },
};

const keyBody = z.object({
  project_id: z.string().uuid(),
  provider: z.enum(['openai', 'anthropic', 'google', 'openrouter', 'lovable', 'custom']),
  name: z.string().min(1).max(60),
  api_key: z.string().min(4).max(4096),
  base_url: z.string().url().optional(),
});

const chatBody = z.object({
  project_id: z.string().uuid(),
  provider: z.enum(['openai', 'lovable', 'openrouter']).default('lovable'),
  key_name: z.string().default('default'),
  model: z.string().min(1),
  messages: z.array(z.record(z.any())).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32000).optional(),
});

const embedBody = z.object({
  project_id: z.string().uuid(),
  provider: z.enum(['openai', 'lovable', 'openrouter']).default('lovable'),
  key_name: z.string().default('default'),
  model: z.string().default('google/gemini-embedding-001'),
  input: z.union([z.string(), z.array(z.string())]),
});

const enqueueEmbedBody = z.object({
  project_id: z.string().uuid(),
  schema_name: z.string(),
  table_name: z.string(),
  target_column: z.string(),
  source_column: z.string(),
  where_sql: z.string().optional(), // safe: parameterless "where <expr>" applied to selection
  model: z.string().default('google/gemini-embedding-001'),
  limit: z.number().int().min(1).max(50_000).default(1000),
});

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function baseUrlFor(provider: string, override?: string | null) {
  if (override) return override.replace(/\/+$/, '');
  switch (provider) {
    case 'lovable': return 'https://ai.gateway.lovable.dev/v1';
    case 'openai': return 'https://api.openai.com/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    default: return 'https://ai.gateway.lovable.dev/v1';
  }
}

async function resolveKey(cfg: Config, projectId: string, provider: string, name: string) {
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`
    select api_key, base_url from admin.ai_provider_keys
    where project_id = ${projectId} and provider = ${provider} and name = ${name}`;
  if (row) return { key: row.api_key, base_url: row.base_url as string | null };
  // Fallback: platform LOVABLE_API_KEY (server env).
  const platform = process.env.LOVABLE_API_KEY;
  if (!platform) { const e: any = new Error('no_ai_key_configured'); e.statusCode = 400; throw e; }
  return { key: platform, base_url: null };
}

function cost(model: string, inTok = 0, outTok = 0) {
  const p = PRICE[model];
  if (!p) return null;
  return Number(((inTok * p.in + outTok * p.out) / 1000).toFixed(6));
}

async function logCall(cfg: Config, row: {
  project_id: string; provider: string; model: string; operation: string;
  input_tokens?: number; output_tokens?: number; latency_ms: number; status: number;
  actor_id?: string | null; request_hash: string; meta?: any;
}) {
  const c = cost(row.model, row.input_tokens ?? 0, row.output_tokens ?? 0);
  await getSql(cfg)`
    insert into admin.ai_prompt_logs
      (project_id, provider, model, operation, input_tokens, output_tokens,
       cost_usd, latency_ms, status, actor_id, request_hash, meta)
    values (${row.project_id}, ${row.provider}, ${row.model}, ${row.operation},
            ${row.input_tokens ?? null}, ${row.output_tokens ?? null},
            ${c}, ${row.latency_ms}, ${row.status},
            ${row.actor_id ?? null}, ${row.request_hash}, ${row.meta ?? {} as any})`;
}

export async function aiRoutes(app: FastifyInstance, cfg: Config) {
  // ---------- Keys ----------
  app.get('/ai/v1/keys', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return getSql(cfg)`
      select id, provider, name, base_url, created_at from admin.ai_provider_keys
      where project_id = ${q.project_id} order by provider, name`;
  });

  app.post('/ai/v1/keys', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = keyBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.ai_provider_keys (project_id, provider, name, api_key, base_url)
      values (${body.project_id}, ${body.provider}, ${body.name}, ${body.api_key}, ${body.base_url ?? null})
      on conflict (project_id, provider, name) do update
        set api_key = excluded.api_key, base_url = excluded.base_url
      returning id, provider, name, base_url, created_at`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'ai.key.upsert', target: `${body.provider}:${body.name}` });
    reply.code(201).send(row);
  });

  app.delete('/ai/v1/keys/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.ai_provider_keys where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'ai.key.delete', target: id });
    reply.code(204).send();
  });

  // ---------- Chat proxy ----------
  app.post('/ai/v1/chat', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = chatBody.parse(req.body);
    const { key, base_url } = await resolveKey(cfg, body.project_id, body.provider, body.key_name);
    const url = `${baseUrlFor(body.provider, base_url)}/chat/completions`;
    const payload = { model: body.model, messages: body.messages, temperature: body.temperature, max_tokens: body.max_tokens };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const dur = Date.now() - t0;
    const json: any = await res.json().catch(() => ({}));
    await logCall(cfg, {
      project_id: body.project_id, provider: body.provider, model: body.model,
      operation: 'chat', latency_ms: dur, status: res.status,
      input_tokens: json?.usage?.prompt_tokens, output_tokens: json?.usage?.completion_tokens,
      actor_id: actor.userId, request_hash: hash,
    });
    reply.code(res.status).send(json);
  });

  // ---------- Embeddings proxy ----------
  app.post('/ai/v1/embeddings', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = embedBody.parse(req.body);
    const { key, base_url } = await resolveKey(cfg, body.project_id, body.provider, body.key_name);
    const url = `${baseUrlFor(body.provider, base_url)}/embeddings`;
    const payload = { model: body.model, input: body.input };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const dur = Date.now() - t0;
    const json: any = await res.json().catch(() => ({}));
    await logCall(cfg, {
      project_id: body.project_id, provider: body.provider, model: body.model,
      operation: 'embedding', latency_ms: dur, status: res.status,
      input_tokens: json?.usage?.prompt_tokens, output_tokens: 0,
      actor_id: actor.userId, request_hash: hash,
    });
    reply.code(res.status).send(json);
  });

  // ---------- Prompt logs ----------
  app.get('/ai/v1/logs', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({
      project_id: z.string().uuid(),
      model: z.string().optional(),
      operation: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    return getSql(cfg)`
      select id, provider, model, operation, input_tokens, output_tokens,
             cost_usd, latency_ms, status, created_at
      from admin.ai_prompt_logs
      where project_id = ${q.project_id}
        and (${q.model ?? null}::text is null or model = ${q.model ?? null})
        and (${q.operation ?? null}::text is null or operation = ${q.operation ?? null})
      order by created_at desc limit ${q.limit}`;
  });

  app.get('/ai/v1/costs', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid(), days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    return getSql(cfg)`
      select model, operation, count(*)::int as calls,
             coalesce(sum(input_tokens),0)::bigint as input_tokens,
             coalesce(sum(output_tokens),0)::bigint as output_tokens,
             coalesce(sum(cost_usd),0)::numeric(14,4) as cost_usd
      from admin.ai_prompt_logs
      where project_id = ${q.project_id}
        and created_at > now() - make_interval(days => ${q.days})
      group by model, operation order by cost_usd desc`;
  });

  // ---------- Embedding jobs (fan-out into existing vector column) ----------
  app.post('/ai/v1/embed-jobs/enqueue', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = enqueueEmbedBody.parse(req.body);
    for (const s of [body.schema_name, body.table_name, body.target_column, body.source_column]) {
      if (!SAFE_IDENT.test(s)) { reply.code(400).send({ error: 'invalid_identifier', which: s }); return; }
    }
    const sql = getSql(cfg);
    // Read primary key columns for the target table.
    const pkRows = await sql<any[]>`
      select a.attname as col
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = (${body.schema_name + '.' + body.table_name})::regclass and i.indisprimary`;
    if (pkRows.length === 0) { reply.code(400).send({ error: 'no_primary_key' }); return; }
    const pkCol = pkRows[0].col as string;
    if (!SAFE_IDENT.test(pkCol)) { reply.code(400).send({ error: 'invalid_pk' }); return; }

    // Select rows missing an embedding — bounded by limit.
    const listQuery =
      `select ${pkCol}::text as pk from ${body.schema_name}.${body.table_name} ` +
      `where ${body.target_column} is null ` +
      (body.where_sql ? `and (${body.where_sql}) ` : '') +
      `limit ${body.limit}`;
    const rows: any[] = await sql.unsafe(listQuery);

    let created = 0;
    for (const r of rows) {
      const [ins] = await sql<any[]>`
        insert into admin.embedding_jobs
          (project_id, schema_name, table_name, row_pk, source_column, target_column, model)
        values (${body.project_id}, ${body.schema_name}, ${body.table_name},
                ${r.pk}, ${body.source_column}, ${body.target_column}, ${body.model})
        on conflict do nothing returning id`;
      if (ins) created += 1;
    }
    await logAudit(cfg, { actor_id: actor.userId, action: 'ai.embed.enqueue', target: `${body.schema_name}.${body.table_name}`, detail: { created, model: body.model } });
    reply.send({ created, scanned: rows.length });
  });

  // Worker endpoint: run a batch of pending embedding jobs.
  app.post('/ai/v1/embed-jobs/tick', async (req) => {
    await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(),
      batch: z.number().int().min(1).max(50).default(10),
      provider: z.enum(['openai', 'lovable', 'openrouter']).default('lovable'),
      key_name: z.string().default('default'),
    }).parse(req.body);
    const sql = getSql(cfg);
    const jobs = await sql<any[]>`
      update admin.embedding_jobs set status = 'running', attempts = attempts + 1, updated_at = now()
      where id in (
        select id from admin.embedding_jobs
        where project_id = ${body.project_id} and status = 'pending'
        order by created_at limit ${body.batch}
      )
      returning *`;
    if (jobs.length === 0) return { processed: 0 };
    const { key, base_url } = await resolveKey(cfg, body.project_id, body.provider, body.key_name);
    let done = 0, failed = 0;
    for (const j of jobs) {
      try {
        // fetch source text
        const src = `select ${j.source_column}::text as t from ${j.schema_name}.${j.table_name} where ${await pkColumn(cfg, j.schema_name, j.table_name)} = ${sqlLiteral(j.row_pk)} limit 1`;
        const rows: any[] = await sql.unsafe(src);
        const text = rows[0]?.t ?? '';
        if (!text) throw new Error('empty_source');
        const res = await fetch(`${baseUrlFor(body.provider, base_url)}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: j.model, input: text }),
        });
        const jr: any = await res.json();
        if (!res.ok) throw new Error(jr?.error?.message || `status_${res.status}`);
        const vec = jr?.data?.[0]?.embedding as number[];
        if (!Array.isArray(vec)) throw new Error('no_vector');
        const lit = '[' + vec.map((n) => Number(n).toString()).join(',') + ']';
        await sql.unsafe(
          `update ${j.schema_name}.${j.table_name} set ${j.target_column} = ${sqlLiteral(lit)}::vector where ${await pkColumn(cfg, j.schema_name, j.table_name)} = ${sqlLiteral(j.row_pk)}`,
        );
        await sql`update admin.embedding_jobs set status = 'done', updated_at = now() where id = ${j.id}`;
        done += 1;
      } catch (e: any) {
        await sql`update admin.embedding_jobs set status = 'failed', last_error = ${String(e.message ?? e)}, updated_at = now() where id = ${j.id}`;
        failed += 1;
      }
    }
    return { processed: jobs.length, done, failed };
  });

  app.get('/ai/v1/embed-jobs', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return getSql(cfg)`
      select id, schema_name, table_name, target_column, model, status, attempts, last_error, updated_at
      from admin.embedding_jobs
      where project_id = ${q.project_id}
        and (${q.status ?? null}::text is null or status = ${q.status ?? null})
      order by updated_at desc limit ${q.limit}`;
  });
}

// Simple literal quoter — only used on values we control (row_pk from DB, vector literal).
function sqlLiteral(v: string) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function pkColumn(cfg: Config, schema: string, table: string): Promise<string> {
  const sql = getSql(cfg);
  const rows = await sql<any[]>`
    select a.attname as col
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = (${schema + '.' + table})::regclass and i.indisprimary limit 1`;
  const col = rows[0]?.col;
  if (!col || !SAFE_IDENT.test(col)) throw new Error('invalid_pk');
  return col;
}
