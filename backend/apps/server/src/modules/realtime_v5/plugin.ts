// Phase 60 — Realtime v5 plugin.
//
// Endpoints (gated by PLUTO_ENABLE_REALTIME_V5=1):
//   POST /rt/v5/presence            — upsert presence (returns shard)
//   DELETE /rt/v5/presence          — remove presence
//   GET  /rt/v5/presence/:room      — list room members
//   GET  /rt/v5/shards              — per-shard sizes
//   POST /rt/v5/publish             — publish ordered message to a room
//   POST /rt/v5/subscribe           — register a subscriber (returns id)
//   DELETE /rt/v5/subscribe/:id     — cancel subscription
//   GET  /rt/v5/drain/:id           — drain queued messages
//   POST /rt/v5/resume/:id          — resume a paused subscriber
//   GET  /rt/v5/room/:room/stats    — ordered-delivery + backpressure stats

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  upsertPresence, removePresence, listRoom, shardStats, whichShard,
} from "../../lib/presence-shard.js";
import { ingest, roomStats, type RoomMessage } from "../../lib/ordered-delivery.js";
import {
  subscribe, unsubscribe, push, drain, resume, stats as subStats,
} from "../../lib/room-backpressure.js";

const enabled = process.env.PLUTO_ENABLE_REALTIME_V5 === "1";
const roomSeq = new Map<string, number>();

export async function realtimeV5Plugin(app: FastifyInstance) {
  if (!enabled) return;

  app.addHook("preHandler", async (req, reply) => {
    if (!req.headers["x-workspace-id"]) { reply.code(400); return { error: "missing_workspace" }; }
  });

  // ---- presence -----------------------------------------------------------
  app.post("/rt/v5/presence", async (req, reply) => {
    const ws = req.headers["x-workspace-id"] as string;
    const b = z.object({
      room: z.string().min(1).max(200),
      user_id: z.string().min(1),
      status: z.enum(["online", "away", "offline"]),
      meta: z.record(z.unknown()).optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400); return { error: "bad_request", issues: b.error.issues }; }
    const r = upsertPresence({ workspace: ws, ...b.data });
    return r;
  });

  app.delete("/rt/v5/presence", async (req, reply) => {
    const ws = req.headers["x-workspace-id"] as string;
    const b = z.object({ room: z.string(), user_id: z.string() }).safeParse(req.body);
    if (!b.success) { reply.code(400); return { error: "bad_request" }; }
    return { removed: removePresence(ws, b.data.room, b.data.user_id) };
  });

  app.get("/rt/v5/presence/:room", async (req) => {
    const ws = req.headers["x-workspace-id"] as string;
    const room = (req.params as { room: string }).room;
    return { members: listRoom(ws, room) };
  });

  app.get("/rt/v5/shards", async () => ({ shards: shardStats() }));

  app.get("/rt/v5/shard-for/:user", async (req) => {
    const ws = req.headers["x-workspace-id"] as string;
    const user = (req.params as { user: string }).user;
    return { shard: whichShard(ws, user) };
  });

  // ---- ordered publish/subscribe -----------------------------------------
  app.post("/rt/v5/publish", async (req, reply) => {
    const b = z.object({
      room: z.string().min(1),
      payload: z.unknown(),
      seq: z.number().int().min(1).optional(),
      id: z.string().min(1).optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400); return { error: "bad_request", issues: b.error.issues }; }
    const seq = b.data.seq ?? ((roomSeq.get(b.data.room) ?? 0) + 1);
    roomSeq.set(b.data.room, Math.max(seq, roomSeq.get(b.data.room) ?? 0));
    const msg: RoomMessage = {
      room: b.data.room, seq,
      id: b.data.id ?? `m_${seq}_${Math.random().toString(36).slice(2, 8)}`,
      payload: b.data.payload, ts: Date.now(),
    };
    const res = ingest(msg);
    let delivered = 0, dropped = 0, paused = 0;
    for (const m of res.deliver) {
      const r = push(m.room, m);
      delivered += r.delivered; dropped += r.dropped; paused += r.paused;
    }
    return { accepted: !res.dropped, dropped_reason: res.dropped, delivered_count: res.deliver.length, subscribers: { delivered, dropped, paused }, skipped_seq: res.skipped, seq };
  });

  app.post("/rt/v5/subscribe", async (req, reply) => {
    const b = z.object({
      room: z.string().min(1),
      policy: z.enum(["drop_oldest", "drop_newest", "pause"]).default("drop_oldest"),
      max_queue: z.number().int().min(1).max(10_000).default(100),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400); return { error: "bad_request" }; }
    const id = `sub_${Math.random().toString(36).slice(2, 12)}`;
    subscribe(id, b.data.room, { policy: b.data.policy, max_queue: b.data.max_queue });
    return { id };
  });

  app.delete("/rt/v5/subscribe/:id", async (req) => {
    unsubscribe((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get("/rt/v5/drain/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const q = z.object({ n: z.coerce.number().int().min(1).max(1000).default(100) }).safeParse(req.query);
    const n = q.success ? q.data.n : 100;
    return { messages: drain(id, n), stats: subStats(id) };
  });

  app.post("/rt/v5/resume/:id", async (req, reply) => {
    const ok = resume((req.params as { id: string }).id);
    if (!ok) { reply.code(404); return { error: "not_found" }; }
    return { ok: true };
  });

  app.get("/rt/v5/room/:room/stats", async (req) => {
    const room = (req.params as { room: string }).room;
    return { ordered: roomStats(room) };
  });
}
