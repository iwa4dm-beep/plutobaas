// Phase 43 — Realtime v3: CDC + NATS backplane + RLS-aware channels + replay.
//
// Endpoints (all under /rt/v3):
//   POST   /rt/v3/channels                  — create/update a channel (admin)
//   GET    /rt/v3/channels                  — list channels visible to workspace
//   DELETE /rt/v3/channels/:name            — remove a channel (admin)
//   POST   /rt/v3/publish                   — publish a broadcast event (admin/service)
//   GET    /rt/v3/replay/:name              — replay events since cursor
//   POST   /rt/v3/subscriptions             — register/update a subscriber cursor
//   GET    /rt/v3/nats                      — backplane status + last error
//
// The socket transport is provided by realtime_v2; this module owns the
// channel registry, RLS predicate evaluation, replay ring buffer, and
// NATS fan-out for horizontal scale-out.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { audit } from "../../lib/audit.js";
import { connectNats, natsStatus, publishBackplane } from "../../lib/nats-backplane.js";
import { parsePredicate, type PredicateContext } from "../../lib/rls-predicate.js";

const enabled = process.env.PLUTO_ENABLE_REALTIME_V3 === "1";
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;
const NAME  = /^[a-z0-9_:.\-]{1,128}$/i;

export async function realtimeV3Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);
  void connectNats(app.log);

  // -------- channel registry --------

  app.post("/rt/v3/channels", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      name:             z.string().regex(NAME),
      schema:           z.string().regex(IDENT).default("public"),
      table:            z.string().regex(IDENT),
      rls_predicate:    z.string().max(1000).nullable().optional(),
      require_role:     z.enum(["authenticated","admin"]).nullable().optional(),
      replay_window_s:  z.number().int().min(60).max(86400).default(3600),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });

    // Validate predicate up-front so bad expressions fail fast instead of
    // silently dropping every event at delivery time.
    if (body.data.rls_predicate) {
      try { parsePredicate(body.data.rls_predicate); }
      catch (e) { return reply.code(400).send({ error: "invalid_predicate", message: (e as Error).message }); }
    }

    const ws = req.auth?.workspaceId ?? null;
    await db.insertInto("rt3_channels" as never).values({
      workspace_id: ws,
      name: body.data.name,
      schema_name: body.data.schema,
      table_name: body.data.table,
      rls_predicate: body.data.rls_predicate ?? null,
      require_role: body.data.require_role ?? null,
      replay_window_s: body.data.replay_window_s,
    } as never).onConflict((c: unknown) =>
      (c as { columns: (k: string[]) => { doUpdateSet: (u: unknown) => unknown } })
        .columns(["workspace_id", "name"])
        .doUpdateSet({
          schema_name: body.data.schema,
          table_name: body.data.table,
          rls_predicate: body.data.rls_predicate ?? null,
          require_role: body.data.require_role ?? null,
          replay_window_s: body.data.replay_window_s,
        })).execute();

    await audit(req, { action: "rt3.channel.upsert", status: "ok",
      metadata: { name: body.data.name, workspace_id: ws } });
    return { ok: true };
  });

  app.get("/rt/v3/channels", async (req) => {
    const ws = req.auth?.workspaceId ?? null;
    const rows = await db.selectFrom("rt3_channels" as never).selectAll()
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .orderBy("name" as never, "asc").execute();
    return { channels: rows };
  });

  app.delete("/rt/v3/channels/:name", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!NAME.test(name)) return reply.code(400).send({ error: "invalid_name" });
    const ws = req.auth?.workspaceId ?? null;
    await db.deleteFrom("rt3_channels" as never)
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .where("name" as never, "=", name as never).execute();
    await audit(req, { action: "rt3.channel.delete", status: "ok", metadata: { name } });
    return { ok: true };
  });

  // -------- publish (server-authoritative broadcast) --------

  app.post("/rt/v3/publish", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      channel:    z.string().regex(NAME),
      event_type: z.enum(["INSERT","UPDATE","DELETE","BROADCAST"]).default("BROADCAST"),
      payload:    z.record(z.unknown()),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });

    const ws = req.auth?.workspaceId ?? null;
    const chan = await db.selectFrom("rt3_channels" as never).selectAll()
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .where("name" as never, "=", body.data.channel as never)
      .executeTakeFirst() as unknown as { name: string } | undefined;
    if (!chan) return reply.code(404).send({ error: "channel_not_found" });

    const subject = `${process.env.PLUTO_NATS_SUBJECT_PREFIX ?? "pluto.rt3"}.${body.data.channel}`;
    const delivery = await publishBackplane(subject, {
      channel: body.data.channel, event: body.data.event_type,
      payload: body.data.payload, ts: new Date().toISOString(),
    }, app.log);

    // Always persist to the ring buffer so subscribers can replay even if
    // NATS is down or a subscriber missed the fan-out entirely.
    await db.insertInto("rt3_backplane_log" as never).values({
      channel_name:   body.data.channel,
      event_type:     body.data.event_type,
      payload:        body.data.payload,
      nats_subject:   subject,
      delivered_nats: delivery.delivered,
      delivery_error: delivery.error,
    } as never).execute();

    return { ok: true, delivered_nats: delivery.delivered, delivery_error: delivery.error };
  });

  // -------- replay --------

  app.get("/rt/v3/replay/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!NAME.test(name)) return reply.code(400).send({ error: "invalid_name" });
    const q = z.object({
      since_id: z.coerce.number().int().optional(),
      limit:    z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "bad_query" });

    const ws = req.auth?.workspaceId ?? null;
    const chan = await db.selectFrom("rt3_channels" as never).selectAll()
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .where("name" as never, "=", name as never)
      .executeTakeFirst() as
      | { rls_predicate: string | null; require_role: string | null; replay_window_s: number }
      | undefined;
    if (!chan) return reply.code(404).send({ error: "channel_not_found" });

    // Enforce require_role gate — anonymous callers cannot replay
    // authenticated-only channels even with a valid apikey.
    const role = (req.auth?.role as string | undefined) ?? "anon";
    if (chan.require_role === "authenticated" && role === "anon") {
      return reply.code(403).send({ error: "requires_authenticated" });
    }
    if (chan.require_role === "admin" && role !== "admin" && role !== "service_role") {
      return reply.code(403).send({ error: "requires_admin" });
    }

    let base = db.selectFrom("rt3_backplane_log" as never).selectAll()
      .where("channel_name" as never, "=", name as never)
      .where("ts" as never, ">=", new Date(Date.now() - chan.replay_window_s * 1000) as never);
    if (q.data.since_id) base = base.where("id" as never, ">", q.data.since_id as never);
    const rows = await base.orderBy("id" as never, "asc").limit(q.data.limit).execute() as
      Array<{ id: number; payload: Record<string, unknown> }>;

    // Server-side RLS predicate filtering so subscribers never see rows
    // they shouldn't — matches the guarantees of the socket transport.
    const evaluator = chan.rls_predicate ? parsePredicate(chan.rls_predicate) : null;
    const ctx: PredicateContext = {
      userId: (req.auth?.userId as string | null | undefined) ?? null,
      role,
      workspaceId: ws,
    };
    const filtered = evaluator
      ? rows.filter(r => {
          try { return evaluator.evaluate(r.payload, ctx); }
          catch { return false; }
        })
      : rows;

    return { events: filtered, cursor: filtered.at(-1)?.id ?? q.data.since_id ?? 0 };
  });

  // -------- subscriber cursors --------

  app.post("/rt/v3/subscriptions", async (req, reply) => {
    const body = z.object({
      channel:       z.string().regex(NAME),
      subscriber_id: z.string().min(1).max(128),
      last_event_id: z.number().int().nonnegative().default(0),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });

    const ws = req.auth?.workspaceId ?? null;
    const chan = await db.selectFrom("rt3_channels" as never).select(["id" as never])
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .where("name" as never, "=", body.data.channel as never)
      .executeTakeFirst() as unknown as { id: string } | undefined;
    if (!chan) return reply.code(404).send({ error: "channel_not_found" });

    await db.insertInto("rt3_subscriptions" as never).values({
      channel_id: chan.id,
      subscriber_id: body.data.subscriber_id,
      user_id: req.auth?.userId ?? null,
      last_event_id: body.data.last_event_id,
      last_seen: new Date(),
    } as never).onConflict((c: unknown) =>
      (c as { columns: (k: string[]) => { doUpdateSet: (u: unknown) => unknown } })
        .columns(["channel_id", "subscriber_id"])
        .doUpdateSet({ last_event_id: body.data.last_event_id, last_seen: new Date() })).execute();
    return { ok: true };
  });

  // -------- backplane observability --------

  app.get("/rt/v3/nats", async () => natsStatus());
}
