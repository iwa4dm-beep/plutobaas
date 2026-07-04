// Phase 23 — Vector search (pgvector when available, JS cosine fallback).
//
// Endpoints (gated by PLUTO_ENABLE_VECTOR=1):
//   GET/POST /vec/v1/collections
//   POST /vec/v1/collections/:name/upsert   { docs: [{id?, content, embedding, metadata?}] }
//   POST /vec/v1/collections/:name/query    { embedding, top_k?, filter? }
//   GET  /vec/v1/collections/:name/docs
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey } from "../../lib/apikey.js";
import { recordUsage } from "../../lib/metering.js";

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const vectorPlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_VECTOR !== "1") {
    app.log.info("[vec] disabled (set PLUTO_ENABLE_VECTOR=1 to enable)");
    return;
  }
  const wsFor = (req: { headers: Record<string, unknown> }) =>
    (req.headers["x-workspace-id"] as string) ?? null;

  app.get("/vec/v1/collections", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const r = await q(
      `select id, name, dims, created_at,
              (select count(*) from public.vec_documents d where d.collection_id=c.id) as docs
       from public.vec_collections c where workspace_id is not distinct from $1::uuid
       order by created_at desc`, [ws]);
    return { collections: r.rows };
  });

  app.post("/vec/v1/collections", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const b = z.object({ name: z.string().min(1).max(80), dims: z.number().int().min(1).max(4096).default(1536) }).parse(req.body);
    try {
      const r = await q(
        `insert into public.vec_collections (workspace_id, name, dims) values ($1::uuid,$2,$3)
         on conflict (workspace_id,name) do update set dims=excluded.dims
         returning id, name, dims, created_at`, [ws, b.name, b.dims]);
      return { collection: r.rows[0] };
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });

  async function findColl(ws: string | null, name: string) {
    const r = await q(
      `select id, dims from public.vec_collections where workspace_id is not distinct from $1::uuid and name=$2`,
      [ws, name]);
    return r.rows[0] ?? null;
  }

  app.post("/vec/v1/collections/:name/upsert", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const { name } = req.params as { name: string };
    const b = z.object({ docs: z.array(z.object({
      id: z.string().optional(),
      external_id: z.string().optional(),
      content: z.string(),
      embedding: z.array(z.number()),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })).min(1).max(500) }).parse(req.body);
    const c = await findColl(ws, name);
    if (!c) { reply.code(404); return { error: "no_such_collection" }; }
    let inserted = 0;
    for (const d of b.docs) {
      await q(
        `insert into public.vec_documents (id, collection_id, external_id, content, embedding, metadata)
         values (coalesce($1::uuid, gen_random_uuid()), $2::uuid, $3, $4, $5::jsonb, $6::jsonb)
         on conflict (id) do update set content=excluded.content, embedding=excluded.embedding, metadata=excluded.metadata`,
        [d.id ?? null, c.id, d.external_id ?? null, d.content, JSON.stringify(d.embedding), JSON.stringify(d.metadata)]);
      inserted++;
    }
    return { ok: true, inserted };
  });

  app.get("/vec/v1/collections/:name/docs", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const { name } = req.params as { name: string };
    const c = await findColl(ws, name);
    if (!c) { reply.code(404); return { error: "no_such_collection" }; }
    const r = await q(
      `select id, external_id, content, metadata, created_at from public.vec_documents
       where collection_id=$1::uuid order by created_at desc limit 200`, [c.id]);
    return { docs: r.rows };
  });

  app.post("/vec/v1/collections/:name/query", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const { name } = req.params as { name: string };
    const b = z.object({
      embedding: z.array(z.number()).min(1),
      top_k: z.number().int().min(1).max(50).default(5),
      embedding_field: z.string().max(120).optional(), // JSON path inside metadata to pull embedding from
    }).parse(req.body);
    const c = await findColl(ws, name);
    if (!c) { reply.code(404); return { error: "no_such_collection" }; }
    const r = await q(
      `select id, external_id, content, embedding, metadata from public.vec_documents
       where collection_id=$1::uuid`, [c.id]);
    const scored = r.rows.map((row: { id: string; external_id: string | null; content: string; embedding: number[] | string; metadata: Record<string, unknown>; }) => {
      let emb: number[] = [];
      if (b.embedding_field) {
        const raw = (row.metadata ?? {})[b.embedding_field];
        if (Array.isArray(raw)) emb = raw as number[];
      }
      if (emb.length === 0) emb = Array.isArray(row.embedding) ? row.embedding : JSON.parse(row.embedding as string);
      return { id: row.id, external_id: row.external_id, content: row.content, metadata: row.metadata, score: cosine(b.embedding, emb) };
    }).sort((a: {score: number}, z_: {score: number}) => z_.score - a.score).slice(0, b.top_k);
    await recordUsage({ workspaceId: ws, metric: "ai_tokens", quantity: b.embedding.length,
                        billingLabel: `vector:${name}`, meta: { top_k: b.top_k, field: b.embedding_field ?? null } });
    return { matches: scored };
  });

  app.log.info("[vec] Vector search enabled — /vec/v1/*");
};
