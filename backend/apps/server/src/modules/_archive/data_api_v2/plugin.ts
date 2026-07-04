// Phase 44 — Data API v2: embedded relations + DB Webhooks + FDW registry.
//
// Endpoints (all require apikey, gated by PLUTO_ENABLE_DATA_API_V2=1):
//
//   GET    /rest/v2/embed/:table?select=col,rel(*)&limit=…
//                                      — read with PostgREST-style embedding
//
//   POST   /webhooks/v1                 — create webhook (admin)
//   GET    /webhooks/v1                 — list webhooks in workspace
//   PATCH  /webhooks/v1/:id             — update / enable / disable (admin)
//   DELETE /webhooks/v1/:id             — remove (admin)
//   POST   /webhooks/v1/:id/test        — enqueue a test delivery (admin)
//   GET    /webhooks/v1/:id/deliveries  — recent deliveries
//   POST   /webhooks/v1/tick            — trigger dispatcher sweep (admin)
//
//   POST   /fdw/v1/servers              — register foreign server (admin)
//   GET    /fdw/v1/servers              — list
//   DELETE /fdw/v1/servers/:id          — drop (admin)
//   POST   /fdw/v1/tables               — register foreign table entry (admin)
//   GET    /fdw/v1/tables               — list

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { env } from "../../../config.js";
import { db } from "../../../db/index.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../../lib/apikey.js";
import { audit } from "../../../lib/audit.js";
import { parseSelect, expandEmbeds, scalarColumns } from "../../../lib/embed.js";
import {
  dispatchDueDeliveries, enqueueWebhookEvent, startWebhookSweeper,
} from "../../../lib/webhook-dispatcher.js";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;
const WRAPPERS = new Set(["postgres_fdw", "file_fdw"]);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });

export const dataApiV2Plugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_DATA_API_V2 !== "1") {
    app.log.info("[data_api_v2] disabled (set PLUTO_ENABLE_DATA_API_V2=1 to enable)");
    return;
  }
  app.addHook("preHandler", requireApiKey);
  startWebhookSweeper(app.log);

  // ============== embedded relations ==============

  app.get("/rest/v2/embed/:table", async (req, reply) => {
    const { table } = req.params as { table: string };
    if (!IDENT.test(table)) return reply.code(400).send({ error: "invalid_table" });
    const q = z.object({
      select: z.string().default("*"),
      limit:  z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "bad_query" });

    let nodes;
    try { nodes = parseSelect(q.data.select); }
    catch (e) { return reply.code(400).send({ error: "invalid_select", message: (e as Error).message }); }

    const client = await pool.connect();
    try {
      const cols = scalarColumns(nodes);
      const parentSql = `select ${cols} from "public"."${table}" limit $1 offset $2`;
      const parent = await client.query(parentSql, [q.data.limit, q.data.offset]);
      await expandEmbeds(client, "public", table, parent.rows, nodes);
      return { rows: parent.rows, count: parent.rows.length };
    } catch (e) {
      return reply.code(400).send({ error: "query_failed", message: (e as Error).message });
    } finally { client.release(); }
  });

  // ============== DB Webhooks ==============

  app.post("/webhooks/v1", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      name:        z.string().min(1).max(128),
      schema:      z.string().regex(IDENT).default("public"),
      table:       z.string().regex(IDENT),
      events:      z.array(z.enum(["INSERT","UPDATE","DELETE"])).min(1),
      url:         z.string().url(),
      secret:      z.string().min(16).optional(),
      headers:     z.record(z.string()).default({}),
      max_retries: z.number().int().min(0).max(20).default(5),
      timeout_ms:  z.number().int().min(1000).max(60000).default(10000),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });

    const secret = body.data.secret ?? randomBytes(32).toString("hex");
    const ws = req.auth?.workspaceId ?? null;
    const row = await db.insertInto("db_webhooks" as never).values({
      workspace_id: ws, name: body.data.name,
      schema_name: body.data.schema, table_name: body.data.table,
      events: body.data.events, url: body.data.url,
      secret, headers: body.data.headers,
      max_retries: body.data.max_retries, timeout_ms: body.data.timeout_ms,
    } as never).returning(["id" as never]).executeTakeFirst() as { id: string };
    await audit(req, { action: "webhook.create", status: "ok", metadata: { id: row.id, url: body.data.url } });
    return { id: row.id, secret };
  });

  app.get("/webhooks/v1", async (req) => {
    const ws = req.auth?.workspaceId ?? null;
    const rows = await db.selectFrom("db_webhooks" as never)
      .select([
        "id" as never, "name" as never, "schema_name" as never, "table_name" as never,
        "events" as never, "url" as never, "enabled" as never,
        "max_retries" as never, "timeout_ms" as never, "created_at" as never,
      ])
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .orderBy("created_at" as never, "desc").execute();
    return { webhooks: rows };
  });

  app.patch("/webhooks/v1/:id", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      enabled:     z.boolean().optional(),
      url:         z.string().url().optional(),
      events:      z.array(z.enum(["INSERT","UPDATE","DELETE"])).min(1).optional(),
      headers:     z.record(z.string()).optional(),
      max_retries: z.number().int().min(0).max(20).optional(),
      timeout_ms:  z.number().int().min(1000).max(60000).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const patch: Record<string, unknown> = { ...body.data, updated_at: new Date() };
    const ws = req.auth?.workspaceId ?? null;
    await db.updateTable("db_webhooks" as never).set(patch as never)
      .where("id" as never, "=", id as never)
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .execute();
    await audit(req, { action: "webhook.update", status: "ok", metadata: { id } });
    return { ok: true };
  });

  app.delete("/webhooks/v1/:id", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.auth?.workspaceId ?? null;
    await db.deleteFrom("db_webhooks" as never)
      .where("id" as never, "=", id as never)
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .execute();
    await audit(req, { action: "webhook.delete", status: "ok", metadata: { id } });
    return { ok: true };
  });

  app.post("/webhooks/v1/:id/test", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const hook = await db.selectFrom("db_webhooks" as never).selectAll()
      .where("id" as never, "=", id as never)
      .executeTakeFirst() as { schema_name: string; table_name: string } | undefined;
    if (!hook) return reply.code(404).send({ error: "not_found" });
    await db.insertInto("db_webhook_deliveries" as never).values({
      webhook_id: id, event_type: "INSERT",
      payload: { test: true, ts: new Date().toISOString() },
      status: "pending", next_retry_at: new Date(),
    } as never).execute();
    const r = await dispatchDueDeliveries(req.log, 5);
    return { ok: true, ...r };
  });

  app.get("/webhooks/v1/:id/deliveries", async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db.selectFrom("db_webhook_deliveries" as never).selectAll()
      .where("webhook_id" as never, "=", id as never)
      .orderBy("id" as never, "desc").limit(100).execute();
    return { deliveries: rows };
  });

  app.post("/webhooks/v1/tick", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    return dispatchDueDeliveries(req.log, 50);
  });

  // Programmatic entry point for other modules (CDC, REST writes, etc.)
  // to enqueue a webhook event. Exposed as an internal endpoint too so
  // trusted service_role callers can drive it from SQL triggers.
  app.post("/webhooks/v1/emit", async (req, reply) => {
    if (req.auth?.apiKey !== "service_role") return reply.code(403).send({ error: "service_role_required" });
    const body = z.object({
      schema: z.string().regex(IDENT).default("public"),
      table:  z.string().regex(IDENT),
      event:  z.enum(["INSERT","UPDATE","DELETE"]),
      payload: z.record(z.unknown()),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const enqueued = await enqueueWebhookEvent(body.data);
    return { ok: true, enqueued };
  });

  // ============== Foreign Data Wrappers ==============

  app.post("/fdw/v1/servers", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      name:         z.string().regex(IDENT),
      wrapper:      z.string(),
      options:      z.record(z.string()).default({}),
      user_mapping: z.record(z.string()).default({}),
      apply:        z.boolean().default(false),  // also run CREATE SERVER
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    if (!WRAPPERS.has(body.data.wrapper)) return reply.code(400).send({ error: "unsupported_wrapper" });

    const ws = req.auth?.workspaceId ?? null;
    const row = await db.insertInto("fdw_servers" as never).values({
      workspace_id: ws, name: body.data.name, wrapper: body.data.wrapper,
      options: body.data.options, user_mapping: body.data.user_mapping,
    } as never).returning(["id" as never]).executeTakeFirst() as { id: string };

    let applied = false, apply_error: string | null = null;
    if (body.data.apply) {
      const client = await pool.connect();
      try {
        await client.query(`create extension if not exists ${body.data.wrapper}`);
        const optSql = Object.entries(body.data.options)
          .map(([k, v]) => `${k.replace(/[^a-z0-9_]/gi,"")} '${String(v).replace(/'/g,"''")}'`)
          .join(", ");
        await client.query(
          `create server if not exists "${body.data.name}" foreign data wrapper ${body.data.wrapper}` +
          (optSql ? ` options (${optSql})` : "")
        );
        if (Object.keys(body.data.user_mapping).length) {
          const umSql = Object.entries(body.data.user_mapping)
            .map(([k, v]) => `${k.replace(/[^a-z0-9_]/gi,"")} '${String(v).replace(/'/g,"''")}'`)
            .join(", ");
          await client.query(
            `create user mapping if not exists for current_user server "${body.data.name}" options (${umSql})`
          );
        }
        applied = true;
      } catch (e) { apply_error = (e as Error).message; }
      finally { client.release(); }
    }
    await audit(req, { action: "fdw.server.create", status: apply_error ? "warn" : "ok",
      metadata: { id: row.id, wrapper: body.data.wrapper, applied, apply_error } });
    return { id: row.id, applied, apply_error };
  });

  app.get("/fdw/v1/servers", async (req) => {
    const ws = req.auth?.workspaceId ?? null;
    const rows = await db.selectFrom("fdw_servers" as never).selectAll()
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .orderBy("created_at" as never, "desc").execute() as Array<Record<string, unknown>>;
    // Never leak passwords back to the client.
    for (const r of rows) {
      const um = r.user_mapping as Record<string, string> | null;
      if (um && um.password) r.user_mapping = { ...um, password: "***" };
    }
    return { servers: rows };
  });

  app.delete("/fdw/v1/servers/:id", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const ws = req.auth?.workspaceId ?? null;
    await db.deleteFrom("fdw_servers" as never)
      .where("id" as never, "=", id as never)
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .execute();
    await audit(req, { action: "fdw.server.delete", status: "ok", metadata: { id } });
    return { ok: true };
  });

  app.post("/fdw/v1/tables", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      server_id:     z.string().uuid(),
      local_schema:  z.string().regex(IDENT).default("public"),
      local_name:    z.string().regex(IDENT),
      remote_schema: z.string().regex(IDENT).optional(),
      remote_name:   z.string().regex(IDENT),
      columns:       z.array(z.object({ name: z.string().regex(IDENT), type: z.string() })).default([]),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });

    const row = await db.insertInto("fdw_tables" as never).values({
      server_id: body.data.server_id,
      local_schema: body.data.local_schema, local_name: body.data.local_name,
      remote_schema: body.data.remote_schema ?? null, remote_name: body.data.remote_name,
      columns: body.data.columns,
    } as never).returning(["id" as never]).executeTakeFirst() as { id: string };
    await audit(req, { action: "fdw.table.create", status: "ok", metadata: { id: row.id } });
    return { id: row.id };
  });

  app.get("/fdw/v1/tables", async () => {
    const rows = await db.selectFrom("fdw_tables" as never).selectAll()
      .orderBy("created_at" as never, "desc").execute();
    return { tables: rows };
  });
};
