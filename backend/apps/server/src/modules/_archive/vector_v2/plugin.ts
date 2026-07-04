// Phase 46 — Vector v2: model registry, HNSW mgmt, embed pipeline, hybrid + RAG.
//
// Endpoints (all under /vec/v2, gated by PLUTO_ENABLE_VECTOR_V2=1):
//
//   Model registry
//     POST   /vec/v2/models              — register a model (admin)
//     GET    /vec/v2/models              — list
//     DELETE /vec/v2/models/:id          — remove (admin)
//
//   HNSW / IVFFLAT index management
//     PUT    /vec/v2/collections/:id/index      — set params (admin)
//     POST   /vec/v2/collections/:id/index/apply — CREATE INDEX (admin)
//
//   Embed pipeline
//     POST   /vec/v2/collections/:id/ingest     — enqueue text/chunks (admin)
//     POST   /vec/v2/embed/tick                 — drain the queue (admin)
//     GET    /vec/v2/embed/jobs                 — recent jobs
//
//   Hybrid search + RAG
//     POST   /vec/v2/collections/:id/search     — hybrid: vector + fts, RRF fused
//     POST   /vec/v2/rag/query                  — { query, collection, top_k } → context chunks

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import pg from "pg";
import { env } from "../../../config.js";
import { db } from "../../../db/index.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../../lib/apikey.js";
import { audit } from "../../../lib/audit.js";
import { embedTexts, chunkText } from "../../../lib/lovable-embeddings.js";
import { rrf } from "../../../lib/rrf.js";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;
const SLUG  = /^[a-z0-9][a-z0-9_\-.]{0,79}$/i;
const pool  = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

function wsFor(req: FastifyRequest): string | null {
  return req.auth?.workspaceId ?? (req.headers["x-workspace-id"] as string) ?? null;
}

async function resolveModel(ws: string | null, slug: string): Promise<{
  id: string; vendor_model: string; dims: number | null; kind: string;
} | undefined> {
  return await db.selectFrom("ai_models" as never).selectAll()
    .where("workspace_id" as never, "is not distinct from", ws as never)
    .where("slug" as never, "=", slug as never)
    .where("enabled" as never, "=", true as never)
    .executeTakeFirst() as never;
}

export const vectorV2Plugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_VECTOR_V2 !== "1") {
    app.log.info("[vec2] disabled (set PLUTO_ENABLE_VECTOR_V2=1 to enable)");
    return;
  }
  app.addHook("preHandler", requireApiKey);

  // =============== Model registry ===============

  app.post("/vec/v2/models", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      slug:         z.string().regex(SLUG),
      provider:     z.enum(["google", "openai", "lovable"]),
      kind:         z.enum(["chat", "embedding", "image", "stt", "tts"]),
      vendor_model: z.string().min(3),
      dims:         z.number().int().min(64).max(4096).optional(),
      price_per_1k: z.number().nonnegative().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });

    const ws = wsFor(req);
    const row = await db.insertInto("ai_models" as never).values({
      workspace_id: ws, ...body.data,
    } as never).onConflict((c: any): any =>
      (c as { columns: (k: string[]) => { doUpdateSet: (u: unknown) => unknown } })
        .columns(["workspace_id", "slug"]).doUpdateSet({
          provider: body.data.provider, kind: body.data.kind,
          vendor_model: body.data.vendor_model, dims: body.data.dims ?? null,
          price_per_1k: body.data.price_per_1k ?? null,
        }))
      .returning(["id" as never]).executeTakeFirst() as unknown as { id: string };
    await audit(req, { action: "ai.model.register", status: "ok", metadata: { slug: body.data.slug } });
    return { id: row.id };
  });

  app.get("/vec/v2/models", async (req) => {
    const ws = wsFor(req);
    const rows = await db.selectFrom("ai_models" as never).selectAll()
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .orderBy("kind" as never, "asc").orderBy("slug" as never, "asc").execute();
    return { models: rows };
  });

  app.delete("/vec/v2/models/:id", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const ws = wsFor(req);
    await db.deleteFrom("ai_models" as never)
      .where("id" as never, "=", id as never)
      .where("workspace_id" as never, "is not distinct from", ws as never).execute();
    return { ok: true };
  });

  // =============== HNSW / IVFFLAT index management ===============

  app.put("/vec/v2/collections/:id/index", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      index_type:      z.enum(["hnsw", "ivfflat", "none"]).default("hnsw"),
      m:               z.number().int().min(4).max(96).default(16),
      ef_construction: z.number().int().min(16).max(512).default(64),
      lists:           z.number().int().min(10).max(4096).default(100),
      operator:        z.enum([
        "vector_cosine_ops", "vector_l2_ops", "vector_ip_ops",
      ]).default("vector_cosine_ops"),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_body" });

    await db.insertInto("vec_index_config" as never).values({
      collection_id: id, ...body.data, applied: false,
    } as never).onConflict((c: any): any =>
      (c as { column: (k: string) => { doUpdateSet: (u: unknown) => unknown } })
        .column("collection_id").doUpdateSet({ ...body.data, applied: false })).execute();
    return { ok: true };
  });

  app.post("/vec/v2/collections/:id/index/apply", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cfg = await db.selectFrom("vec_index_config" as never).selectAll()
      .where("collection_id" as never, "=", id as never)
      .executeTakeFirst() as unknown as {
        index_type: string; m: number; ef_construction: number; lists: number; operator: string;
      } | undefined;
    if (!cfg) return reply.code(404).send({ error: "no_config" });

    // Column is jsonb in the seed migration; a pgvector column can be
    // added out-of-band. If the extension isn't installed, surface the
    // real error so operators know what to fix.
    const client = await pool.connect();
    try {
      await client.query(`create extension if not exists vector`);
      const idxName = `vec_documents_${id.replace(/-/g,"")}_idx`;
      await client.query(`drop index if exists public."${idxName}"`);
      if (cfg.index_type === "hnsw") {
        await client.query(
          `create index "${idxName}" on public.vec_documents
             using hnsw (embedding ${cfg.operator})
             with (m = ${cfg.m}, ef_construction = ${cfg.ef_construction})
             where collection_id = $1::uuid`, [id]);
      } else if (cfg.index_type === "ivfflat") {
        await client.query(
          `create index "${idxName}" on public.vec_documents
             using ivfflat (embedding ${cfg.operator}) with (lists = ${cfg.lists})
             where collection_id = $1::uuid`, [id]);
      }
      await db.updateTable("vec_index_config" as never)
        .set({ applied: true, applied_at: new Date() } as never)
        .where("collection_id" as never, "=", id as never).execute();
      await audit(req, { action: "vec.index.apply", status: "ok",
        metadata: { collection_id: id, index_type: cfg.index_type } });
      return { ok: true, index: idxName };
    } catch (e) {
      return reply.code(400).send({ error: "index_failed", message: (e as Error).message });
    } finally { client.release(); }
  });

  // =============== Embed pipeline ===============

  app.post("/vec/v2/collections/:id/ingest", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      docs: z.array(z.object({
        external_id: z.string().max(256).optional(),
        content:     z.string().min(1),
        metadata:    z.record(z.unknown()).default({}),
      })).min(1).max(500),
      chunk_size:    z.number().int().min(100).max(8000).default(1200),
      chunk_overlap: z.number().int().min(0).max(1000).default(150),
      model_slug:    z.string().default("gemini-embedding-001"),
      source_id:     z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });

    const ws = wsFor(req);
    const jobs: Array<Record<string, unknown>> = [];
    for (const d of body.data.docs) {
      const parts = chunkText(d.content, body.data.chunk_size, body.data.chunk_overlap);
      for (const [i, chunk] of parts.entries()) {
        jobs.push({
          workspace_id: ws, collection_id: id,
          source_id: body.data.source_id ?? null,
          external_id: d.external_id ? `${d.external_id}#${i}` : null,
          content: chunk,
          metadata: { ...d.metadata, chunk_index: i, chunk_of: parts.length },
          model_slug: body.data.model_slug,
        });
      }
    }
    await db.insertInto("vec_embed_jobs" as never).values(jobs as never).execute();
    return { enqueued: jobs.length };
  });

  app.post("/vec/v2/embed/tick", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    return await runEmbedTick(req, 25);
  });

  app.get("/vec/v2/embed/jobs", async (req) => {
    const ws = wsFor(req);
    const rows = await db.selectFrom("vec_embed_jobs" as never)
      .select(["id" as never, "collection_id" as never, "status" as never,
              "attempt" as never, "error" as never, "created_at" as never])
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .orderBy("id" as never, "desc").limit(200).execute();
    return { jobs: rows };
  });

  // =============== Hybrid search + RAG ===============

  app.post("/vec/v2/collections/:id/search", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      query:      z.string().min(1),
      top_k:      z.number().int().min(1).max(100).default(10),
      model_slug: z.string().default("gemini-embedding-001"),
      alpha:      z.number().min(0).max(1).default(0.5),  // reserved (RRF ignores)
      fulltext:   z.boolean().default(true),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });

    const ws = wsFor(req);
    const model = await resolveModel(ws, body.data.model_slug);
    if (!model) return reply.code(400).send({ error: "unknown_model", slug: body.data.model_slug });

    const { vectors } = await embedTexts({ texts: [body.data.query], model: model.vendor_model });
    const qv = vectors[0];

    const client = await pool.connect();
    try {
      // Vector list (JS cosine over jsonb fallback so we work without pgvector).
      const vecRows = await client.query(
        `select id, content, metadata, embedding from public.vec_documents
          where collection_id = $1::uuid limit 2000`, [id]);
      const scored = vecRows.rows.map((r: { id: string; embedding: number[]; content: string; metadata: unknown }) => ({
        id: r.id,
        doc: { id: r.id, content: r.content, metadata: r.metadata },
        cos: cosine(qv, Array.isArray(r.embedding) ? r.embedding : []),
      })).sort((a, b) => b.cos - a.cos).slice(0, body.data.top_k * 4);

      const lists = [scored.map(s => ({ id: s.id, doc: s.doc }))];

      if (body.data.fulltext) {
        const ftsRows = await client.query(
          `select id, content, metadata
             from public.vec_documents
            where collection_id = $1::uuid
              and tsv @@ websearch_to_tsquery('english', $2)
            order by ts_rank(tsv, websearch_to_tsquery('english', $2)) desc
            limit $3`, [id, body.data.query, body.data.top_k * 4]);
        lists.push(ftsRows.rows.map((r: { id: string; content: string; metadata: unknown }) => ({
          id: r.id, doc: { id: r.id, content: r.content, metadata: r.metadata },
        })));
      }
      const fused = rrf(lists, { topK: body.data.top_k });
      return { hits: fused, model: model.vendor_model };
    } catch (e) {
      return reply.code(400).send({ error: "search_failed", message: (e as Error).message });
    } finally { client.release(); }
  });

  app.post("/vec/v2/rag/query", async (req, reply) => {
    const body = z.object({
      query:         z.string().min(1),
      collection_id: z.string().uuid(),
      top_k:         z.number().int().min(1).max(20).default(5),
      model_slug:    z.string().default("gemini-embedding-001"),
      max_context:   z.number().int().min(200).max(20000).default(4000),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });

    // Reuse the hybrid search internally so RAG shares one ranking path.
    const search = await app.inject({
      method: "POST", url: `/vec/v2/collections/${body.data.collection_id}/search`,
      headers: req.headers as Record<string, string>,
      payload: { query: body.data.query, top_k: body.data.top_k, model_slug: body.data.model_slug },
    });
    if (search.statusCode >= 400) { reply.code(search.statusCode); return search.json(); }
    const hits = (search.json() as unknown as { hits: Array<{ doc: { content: string; metadata: unknown } }> }).hits;

    // Concatenate top hits into a bounded context block, with source
    // headers so the caller LLM can cite them.
    const parts: string[] = [];
    let total = 0;
    for (const [i, h] of hits.entries()) {
      const block = `[[source:${i + 1}]]\n${h.doc.content}\n`;
      if (total + block.length > body.data.max_context) break;
      parts.push(block); total += block.length;
    }
    return {
      context:  parts.join("\n"),
      sources:  hits.map((h, i) => ({ n: i + 1, metadata: h.doc.metadata })),
      truncated: parts.length < hits.length,
    };
  });

  // Background sweeper: drain the pipeline continuously.
  const timer = setInterval(() => {
    runEmbedTick(null, 25).catch(e => app.log.warn({ err: e }, "vec embed tick failed"));
  }, 5000);
  app.addHook("onClose", async () => clearInterval(timer));
};

// ---------- helpers ----------

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function runEmbedTick(req: FastifyRequest | null, limit: number) {
  const now = new Date();
  const jobs = await db.selectFrom("vec_embed_jobs" as never).selectAll()
    .where("status" as never, "=", "pending" as never)
    .where("next_retry_at" as never, "<=", now as never)
    .orderBy("id" as never, "asc").limit(limit).execute() as unknown as Array<{
      id: number; workspace_id: string | null; collection_id: string; source_id: string | null;
      external_id: string | null; content: string; metadata: Record<string, unknown>;
      model_slug: string | null; attempt: number;
    }>;
  if (jobs.length === 0) return { processed: 0, done: 0, failed: 0 };

  // Group by model_slug so we batch to the gateway.
  const grouped = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const k = `${j.workspace_id ?? ""}::${j.model_slug ?? "gemini-embedding-001"}`;
    (grouped.get(k) ?? grouped.set(k, []).get(k)!).push(j);
  }

  let done = 0, failed = 0;
  for (const [key, group] of grouped) {
    const [ws, slug] = key.split("::");
    const model = await resolveModel(ws || null, slug);
    if (!model) {
      for (const j of group) await failJob(j, `unknown_model:${slug}`);
      failed += group.length; continue;
    }
    try {
      const { vectors } = await embedTexts({ texts: group.map(g => g.content), model: model.vendor_model });
      for (const [i, j] of group.entries()) {
        const doc = await db.insertInto("vec_documents" as never).values({
          collection_id: j.collection_id, external_id: j.external_id,
          content: j.content, embedding: vectors[i], metadata: j.metadata,
          model_id: model.id, source_id: j.source_id,
        } as never).returning(["id" as never]).executeTakeFirst() as unknown as { id: string };
        await db.updateTable("vec_embed_jobs" as never)
          .set({ status: "done", document_id: doc.id, attempt: j.attempt + 1 } as never)
          .where("id" as never, "=", j.id as never).execute();
        done++;
      }
    } catch (e) {
      const msg = (e as Error).message;
      for (const j of group) await failJob(j, msg);
      failed += group.length;
    }
  }
  req?.log?.info({ processed: jobs.length, done, failed }, "vec embed tick");
  return { processed: jobs.length, done, failed };
}

async function failJob(j: { id: number; attempt: number }, error: string) {
  const next = j.attempt + 1;
  const dead = next >= 5;
  await db.updateTable("vec_embed_jobs" as never).set({
    status: dead ? "failed" : "pending",
    attempt: next, error,
    next_retry_at: dead ? null : new Date(Date.now() + Math.min(300_000, 2 ** next * 1000)),
  } as never).where("id" as never, "=", j.id as never).execute();
}
