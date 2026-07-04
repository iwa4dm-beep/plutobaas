// Phase 23 — Realtime v2: presence + broadcast channels with durable history.
//
// Endpoints (gated by PLUTO_ENABLE_REALTIME_V2=1):
//   GET  /rt2/v1/channels                          — list channels
//   POST /rt2/v1/channels                          — create channel { name, kind }
//   GET  /rt2/v1/channels/:name/messages           — recent broadcast history
//   POST /rt2/v1/channels/:name/broadcast          — publish { event, payload }
//   POST /rt2/v1/channels/:name/presence           — upsert { member_key, metadata }
//   DELETE /rt2/v1/channels/:name/presence/:key    — leave
//   GET  /rt2/v1/channels/:name/presence           — current members
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey } from "../../lib/apikey.js";
import { recordUsage } from "../../lib/metering.js";

export const realtimeV2Plugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_REALTIME_V2 !== "1") {
    app.log.info("[rt2] disabled (set PLUTO_ENABLE_REALTIME_V2=1 to enable)");
    return;
  }

  const wsFor = (req: { headers: Record<string, unknown> }) =>
    (req.headers["x-workspace-id"] as string) ?? null;

  app.get("/rt2/v1/channels", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const rows = await q(
      `select id, name, kind, created_at,
              (select count(*) from public.rt_presence p where p.channel_id = c.id) as members
       from public.rt_channels c where workspace_id is not distinct from $1::uuid
       order by created_at desc`, [ws]);
    return { channels: rows.rows };
  });

  app.post("/rt2/v1/channels", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const b = z.object({ name: z.string().min(1).max(60),
                          kind: z.enum(["broadcast","presence"]).default("broadcast") }).parse(req.body);
    try {
      const r = await q(
        `insert into public.rt_channels (workspace_id, name, kind) values ($1::uuid,$2,$3)
         on conflict (workspace_id, name) do update set kind=excluded.kind
         returning id, name, kind, created_at`, [ws, b.name, b.kind]);
      return { channel: r.rows[0] };
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });

  async function findChannel(ws: string | null, name: string) {
    const r = await q(
      `select id, kind from public.rt_channels where workspace_id is not distinct from $1::uuid and name=$2`,
      [ws, name]);
    return r.rows[0] ?? null;
  }

  app.get("/rt2/v1/channels/:name/messages", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const { name } = req.params as { name: string };
    const limit = Math.min(200, Number((req.query as { limit?: string }).limit ?? 50));
    const ch = await findChannel(ws, name);
    if (!ch) { reply.code(404); return { error: "no_such_channel" }; }
    const rows = await q(
      `select id, event, payload, sender, created_at from public.rt_broadcasts
       where channel_id=$1::uuid order by created_at desc limit $2`, [ch.id, limit]);
    return { messages: rows.rows };
  });

  app.post("/rt2/v1/channels/:name/broadcast", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const { name } = req.params as { name: string };
    const b = z.object({ event: z.string().min(1).max(120),
                          payload: z.record(z.string(), z.unknown()).default({}),
                          sender: z.string().max(120).optional() }).parse(req.body);
    const ch = await findChannel(ws, name);
    if (!ch) { reply.code(404); return { error: "no_such_channel" }; }
    const r = await q(
      `insert into public.rt_broadcasts (channel_id, event, payload, sender)
       values ($1::uuid, $2, $3::jsonb, $4) returning id, created_at`,
      [ch.id, b.event, JSON.stringify(b.payload), b.sender ?? null]);
    return { ok: true, id: r.rows[0].id, at: r.rows[0].created_at };
  });

  app.get("/rt2/v1/channels/:name/presence", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const { name } = req.params as { name: string };
    const ch = await findChannel(ws, name);
    if (!ch) { reply.code(404); return { error: "no_such_channel" }; }
    const rows = await q(
      `select member_key, metadata, last_seen from public.rt_presence
       where channel_id=$1::uuid and last_seen > now() - interval '5 minutes'
       order by last_seen desc`, [ch.id]);
    return { members: rows.rows };
  });

  app.post("/rt2/v1/channels/:name/presence", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const { name } = req.params as { name: string };
    const b = z.object({ member_key: z.string().min(1).max(120),
                          metadata: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
    const ch = await findChannel(ws, name);
    if (!ch) { reply.code(404); return { error: "no_such_channel" }; }
    await q(
      `insert into public.rt_presence (channel_id, member_key, metadata, last_seen)
       values ($1::uuid,$2,$3::jsonb, now())
       on conflict (channel_id, member_key)
       do update set metadata=excluded.metadata, last_seen=now()`,
      [ch.id, b.member_key, JSON.stringify(b.metadata)]);
    return { ok: true };
  });

  app.delete("/rt2/v1/channels/:name/presence/:key", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = wsFor(req);
    const { name, key } = req.params as { name: string; key: string };
    const ch = await findChannel(ws, name);
    if (!ch) { reply.code(404); return { error: "no_such_channel" }; }
    await q(`delete from public.rt_presence where channel_id=$1::uuid and member_key=$2`, [ch.id, key]);
    return { ok: true };
  });

  app.log.info("[rt2] Realtime v2 enabled — /rt2/v1/*");
};
