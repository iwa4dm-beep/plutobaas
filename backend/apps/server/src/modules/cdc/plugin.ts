// Phase 33 — CDC admin plugin.
//
//   GET    /rt/v2/cdc/tables        — list configured tables
//   POST   /rt/v2/cdc/tables        — enable a table { schema, table }
//   DELETE /rt/v2/cdc/tables/:name  — disable a table (schema.table format)
//   GET    /rt/v2/cdc/slot-lag      — bytes buffered in the replication slot
//   POST   /rt/v2/cdc/restart       — drop + recreate the slot (dangerous)
//   GET    /rt/v2/cdc/events        — replay recent events (paginated)
//   POST   /rt/v2/cdc/subscribe     — validate a subscribe payload; returns parsed filter
//
// The actual delivery pipeline runs via the existing pg_notify broadcast
// bus consumed by realtime_v2 sockets; this module owns configuration
// and observability only.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { audit } from "../../lib/audit.js";
import { getSlotLag, startCdcPipeline } from "./dispatcher.js";
import { parseCdcFilter } from "./filter.js";

const enabled = process.env.PLUTO_ENABLE_CDC === "1";
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

export async function cdcPlugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);

  // Kick the pipeline once. Idempotent — subsequent instances no-op via
  // pg_try_advisory_lock inside startCdcPipeline().
  void startCdcPipeline(app.log);

  app.get("/rt/v2/cdc/tables", async (req) => {
    const ws = req.auth?.workspaceId ?? null;
    const rows = await db.selectFrom("cdc_config" as never)
      .select(["schema_name" as never, "table_name" as never, "enabled" as never,
               "created_at" as never, "updated_at" as never])
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .orderBy("schema_name" as never, "asc")
      .orderBy("table_name" as never, "asc")
      .execute();
    return { tables: rows };
  });

  app.post("/rt/v2/cdc/tables", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      schema: z.string().max(63).default("public"),
      table:  z.string().max(63),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    if (!IDENT.test(body.data.schema) || !IDENT.test(body.data.table)) {
      return reply.code(400).send({ error: "invalid_identifier" });
    }
    const ws = req.auth?.workspaceId ?? null;
    await db.insertInto("cdc_config" as never).values({
      workspace_id: ws, schema_name: body.data.schema, table_name: body.data.table,
      enabled: true, updated_at: new Date(),
    } as never).onConflict((c: any) =>
      (c as { columns: (k: string[]) => { doUpdateSet: (u: unknown) => unknown } })
        .columns(["workspace_id", "schema_name", "table_name"])
        .doUpdateSet({ enabled: true, updated_at: new Date() })).execute();

    // Publication is reconciled at startup; run a fast reconcile now too.
    void startCdcPipeline(app.log);

    await audit(req, { action: "cdc.enable_table", status: "ok",
      metadata: { workspace_id: ws, schema: body.data.schema, table: body.data.table } });
    return { ok: true };
  });

  app.delete("/rt/v2/cdc/tables/:qualified", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { qualified } = req.params as { qualified: string };
    const parts = qualified.split(".");
    if (parts.length !== 2 || !parts.every(p => IDENT.test(p))) {
      return reply.code(400).send({ error: "invalid_identifier", expected: "schema.table" });
    }
    const [schema, table] = parts;
    const ws = req.auth?.workspaceId ?? null;
    await db.updateTable("cdc_config" as never).set({ enabled: false, updated_at: new Date() } as never)
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .where("schema_name" as never, "=", schema as never)
      .where("table_name" as never, "=", table as never).execute();
    await audit(req, { action: "cdc.disable_table", status: "ok",
      metadata: { workspace_id: ws, schema, table } });
    return { ok: true };
  });

  app.get("/rt/v2/cdc/slot-lag", async () => {
    const bytes = await getSlotLag();
    return { slot: "pluto_cdc_slot", lag_bytes: bytes };
  });

  app.get("/rt/v2/cdc/events", async (req, reply) => {
    const q = z.object({
      schema: z.string().max(63).optional(),
      table:  z.string().max(63).optional(),
      limit:  z.coerce.number().int().min(1).max(500).default(100),
      since_id: z.coerce.number().int().optional(),
    }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "bad_query" });
    let base = db.selectFrom("cdc_events" as never).selectAll();
    if (q.data.schema) base = base.where("schema_name" as never, "=", q.data.schema as never);
    if (q.data.table)  base = base.where("table_name" as never,  "=", q.data.table  as never);
    if (q.data.since_id) base = base.where("id" as never, ">", q.data.since_id as never);
    const rows = await base.orderBy("id" as never, "desc").limit(q.data.limit).execute();
    return { events: rows };
  });

  app.post("/rt/v2/cdc/subscribe", async (req, reply) => {
    // Validation-only endpoint the frontend can call before opening a
    // websocket subscription; returns the parsed filter or a helpful error.
    const body = z.object({
      event:  z.literal("postgres_changes"),
      schema: z.string().max(63).default("public"),
      table:  z.string().max(63),
      filter: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });
    if (!IDENT.test(body.data.schema) || !IDENT.test(body.data.table)) {
      return reply.code(400).send({ error: "invalid_identifier" });
    }
    let filter = null;
    if (body.data.filter) {
      try { filter = parseCdcFilter(body.data.filter); }
      catch (e) { return reply.code(400).send({ error: "invalid_filter", message: (e as Error).message }); }
    }
    return { ok: true, channel: `postgres_changes:${body.data.schema}:${body.data.table}`, filter };
  });
}
