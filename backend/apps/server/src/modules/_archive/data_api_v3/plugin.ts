// Phase 52 — Data API v3 plugin.
//
// Endpoints (all under /rest/v3, require API key, gated by
// PLUTO_ENABLE_DATA_API_V3=1):
//
//   POST /rest/v3/plan-nested      — plan a nested insert (no execution)
//   POST /rest/v3/computed         — register a computed field
//   GET  /rest/v3/computed         — list computed fields
//   POST /rest/v3/schema/register  — register/refresh a schema descriptor
//   GET  /rest/v3/schema/:name     — read cached schema descriptor
//   POST /rest/v3/schema/invalidate — force cache eviction
//   GET  /rest/v3/types/:name      — generated TypeScript for the descriptor
//
// The plugin is intentionally decoupled from live Postgres introspection so
// it stays testable in isolation; callers submit `SchemaWithTypes`
// descriptors captured by the CLI or a background sweeper.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../../../lib/apikey.js";
import { planNestedInsert, type Schema } from "../../../lib/nested-writes.js";
import { getSchema, invalidate, digestOf } from "../../../lib/schema-cache.js";
import { generateTypes, type SchemaWithTypes } from "../../../lib/type-gen.js";

const enabled = process.env.PLUTO_ENABLE_DATA_API_V3 === "1";

// In-process descriptor registry (workspace-scoped).
const descriptors = new Map<string, SchemaWithTypes>();
const computed = new Map<string, Array<{ name: string; ts_type: string; sql_expr: string }>>();
const dKey = (ws: string, name: string) => `${ws}::${name}`;

const RelationSchema = z.object({
  name: z.string(),
  kind: z.enum(["belongs_to", "has_many"]),
  target_table: z.string(),
  local_column: z.string(),
  target_column: z.string(),
});
const ColumnMetaSchema = z.object({ name: z.string(), type: z.string(), nullable: z.boolean().optional() });
const DescriptorSchema = z.object({
  table: z.string(),
  columns_meta: z.array(ColumnMetaSchema),
  relations: z.record(RelationSchema),
});

export async function dataApiV3Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);

  // ---- nested writes -----------------------------------------------------
  app.post("/rest/v3/plan-nested", async (req, reply) => {
    const body = z.object({
      workspace: z.string().min(1),
      schema_name: z.string().min(1),
      root_table: z.string().min(1),
      payload: z.record(z.unknown()),
    }).safeParse(req.body);
    if (!body.success) { reply.code(400); return { error: "bad_request", issues: body.error.issues }; }

    const desc = descriptors.get(dKey(body.data.workspace, body.data.schema_name));
    if (!desc) { reply.code(404); return { error: "schema_not_registered" }; }

    // Convert SchemaWithTypes → Schema (drop column metadata).
    const s: Schema = {};
    for (const [k, v] of Object.entries(desc)) {
      s[k] = { table: v.table, columns: v.columns_meta.map((c) => c.name), relations: v.relations };
    }
    try {
      const plan = planNestedInsert(s, body.data.root_table, body.data.payload);
      return { ok: true, plan };
    } catch (e) {
      reply.code(400);
      return { error: "plan_failed", message: (e as Error).message };
    }
  });

  // ---- computed fields ---------------------------------------------------
  app.post("/rest/v3/computed", async (req, reply) => {
    const body = z.object({
      workspace: z.string().min(1),
      schema_name: z.string().min(1),
      table: z.string().min(1),
      field_name: z.string().regex(/^[a-z_][a-z0-9_]*$/i),
      sql_expr: z.string().min(1).max(2000),
      ts_type: z.string().default("unknown"),
    }).safeParse(req.body);
    if (!body.success) { reply.code(400); return { error: "bad_request", issues: body.error.issues }; }
    const key = dKey(body.data.workspace, `${body.data.schema_name}.${body.data.table}`);
    const list = computed.get(key) ?? [];
    const existing = list.findIndex((c) => c.name === body.data.field_name);
    const entry = { name: body.data.field_name, ts_type: body.data.ts_type, sql_expr: body.data.sql_expr };
    if (existing >= 0) list[existing] = entry; else list.push(entry);
    computed.set(key, list);
    return { ok: true, field: entry };
  });

  app.get("/rest/v3/computed", async (req, reply) => {
    const q = z.object({
      workspace: z.string().min(1),
      schema_name: z.string().min(1),
      table: z.string().min(1),
    }).safeParse(req.query);
    if (!q.success) { reply.code(400); return { error: "bad_request", issues: q.error.issues }; }
    const list = computed.get(dKey(q.data.workspace, `${q.data.schema_name}.${q.data.table}`)) ?? [];
    return { fields: list };
  });

  // ---- schema cache ------------------------------------------------------
  app.post("/rest/v3/schema/register", async (req, reply) => {
    const body = z.object({
      workspace: z.string().min(1),
      name: z.string().min(1),
      descriptor: z.record(DescriptorSchema),
    }).safeParse(req.body);
    if (!body.success) { reply.code(400); return { error: "bad_request", issues: body.error.issues }; }
    descriptors.set(dKey(body.data.workspace, body.data.name), body.data.descriptor as SchemaWithTypes);

    // Prime the schema-cache so subsequent reads return "cached".
    const asSchema: Schema = {};
    for (const [k, v] of Object.entries(body.data.descriptor)) {
      asSchema[k] = { table: v.table, columns: v.columns_meta.map((c) => c.name), relations: v.relations };
    }
    const digest = digestOf(asSchema);
    await getSchema(body.data.workspace, body.data.name, async () => asSchema, { force: true });
    return { ok: true, digest, tables: Object.keys(body.data.descriptor).length };
  });

  app.get("/rest/v3/schema/:name", async (req, reply) => {
    const q = z.object({ workspace: z.string().min(1) }).safeParse(req.query);
    if (!q.success) { reply.code(400); return { error: "bad_request" }; }
    const name = (req.params as { name: string }).name;
    const desc = descriptors.get(dKey(q.data.workspace, name));
    if (!desc) { reply.code(404); return { error: "not_found" }; }
    const asSchema: Schema = {};
    for (const [k, v] of Object.entries(desc)) {
      asSchema[k] = { table: v.table, columns: v.columns_meta.map((c) => c.name), relations: v.relations };
    }
    const result = await getSchema(q.data.workspace, name, async () => asSchema);
    return { name, cached: result.cached, digest: result.digest, descriptor: desc };
  });

  app.post("/rest/v3/schema/invalidate", async (req, reply) => {
    const body = z.object({
      workspace: z.string().min(1),
      name: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) { reply.code(400); return { error: "bad_request", issues: body.error.issues }; }
    const removed = invalidate(body.data.workspace, body.data.name);
    return { ok: true, removed };
  });

  // ---- generated types ---------------------------------------------------
  app.get("/rest/v3/types/:name", async (req, reply) => {
    const q = z.object({ workspace: z.string().min(1) }).safeParse(req.query);
    if (!q.success) { reply.code(400); return { error: "bad_request" }; }
    const name = (req.params as { name: string }).name;
    const desc = descriptors.get(dKey(q.data.workspace, name));
    if (!desc) { reply.code(404); return { error: "not_found" }; }
    // Merge computed fields into the descriptor for codegen.
    const merged: SchemaWithTypes = {};
    for (const [k, v] of Object.entries(desc)) {
      const list = computed.get(dKey(q.data.workspace, `${name}.${v.table}`)) ?? [];
      merged[k] = { ...v, computed: list.map((c) => ({ name: c.name, ts_type: c.ts_type })) };
    }
    reply.header("content-type", "text/typescript; charset=utf-8");
    return generateTypes(merged);
  });
}
