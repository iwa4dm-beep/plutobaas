// Phase 48 — Broadcast/Presence v2 plugin.
//
// Endpoints (all under /bp/v2):
//   WS   /bp/v2/ws?channel=…&session=…    — per-topic subscribe + heartbeat
//   POST /bp/v2/publish                    — publish ephemeral broadcast (TTL)
//   GET  /bp/v2/replay/:channel            — replay since ?since_seq=N
//   POST /bp/v2/presence/heartbeat         — HTTP presence heartbeat
//   POST /bp/v2/presence/leave             — explicit leave
//   GET  /bp/v2/presence/:channel          — snapshot of online members
//   GET  /bp/v2/stats                      — in-process bus stats
//
// The WebSocket handler is intentionally small: each socket is bound to a
// single channel and receives a monotonically-ordered stream. Clients that
// disconnect can reconnect with `?since_seq=N` to replay missed messages
// within the TTL window.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../../lib/apikey.js";
import {
  publish, subscribe, replay, deliverFromBackplane, _stats,
} from "../../lib/broadcast-bus.js";
import {
  heartbeat, leave, listChannel, newSessionId, pruneMemory,
} from "../../lib/presence-store.js";
import { publishBackplane } from "../../lib/nats-backplane.js";

const enabled = process.env.PLUTO_ENABLE_BROADCAST_V2 === "1";
const CHANNEL = /^[a-z0-9_:.\-]{1,128}$/i;

export async function broadcastV2Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);

  // Background sweeper prunes memory-fallback presence entries.
  const sweeper = setInterval(() => { pruneMemory(); }, 15_000);
  app.addHook("onClose", async () => clearInterval(sweeper));

  // ---- broadcast ---------------------------------------------------------
  app.post("/bp/v2/publish", async (req, reply) => {
    const body = z.object({
      channel: z.string().regex(CHANNEL),
      event:   z.string().min(1).max(64),
      payload: z.unknown().default({}),
      ttl_ms:  z.number().int().min(1).max(24 * 3600_000).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });

    const msg = publish({
      channel: body.data.channel,
      event: body.data.event,
      payload: body.data.payload,
      sender_id: req.auth?.userId ?? null,
      ttl_ms: body.data.ttl_ms,
    });
    // Cross-instance fan-out through NATS when enabled (best-effort).
    void publishBackplane(
      `${process.env.PLUTO_NATS_SUBJECT_PREFIX ?? "pluto.rt3"}.bp.${msg.channel}`,
      msg, app.log,
    );
    return { ok: true, seq: msg.seq, expires_at: msg.expires_at };
  });

  app.get<{ Params: { channel: string }; Querystring: { since_seq?: string } }>(
    "/bp/v2/replay/:channel",
    async (req, reply) => {
      if (!CHANNEL.test(req.params.channel)) return reply.code(400).send({ error: "bad_channel" });
      const since = Number(req.query.since_seq ?? 0) | 0;
      return { messages: replay(req.params.channel, since) };
    },
  );

  // ---- presence ----------------------------------------------------------
  app.post("/bp/v2/presence/heartbeat", async (req, reply) => {
    const body = z.object({
      channel:    z.string().regex(CHANNEL),
      session_id: z.string().uuid().optional(),
      state:      z.record(z.string(), z.unknown()).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });

    const sid = body.data.session_id ?? newSessionId();
    const { entry, joined } = await heartbeat(
      body.data.channel, sid, req.auth?.userId ?? null, body.data.state ?? {},
    );
    if (joined) {
      publish({
        channel: body.data.channel, event: "presence.join",
        payload: { session_id: sid, user_id: entry.user_id, state: entry.state },
        sender_id: entry.user_id, ttl_ms: 60_000,
      });
    }
    return { ok: true, session_id: sid, entry };
  });

  app.post("/bp/v2/presence/leave", async (req, reply) => {
    const body = z.object({
      channel: z.string().regex(CHANNEL),
      session_id: z.string().uuid(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });
    const gone = await leave(body.data.channel, body.data.session_id);
    if (gone) {
      publish({
        channel: body.data.channel, event: "presence.leave",
        payload: { session_id: gone.session_id, user_id: gone.user_id },
        sender_id: gone.user_id, ttl_ms: 60_000,
      });
    }
    return { ok: true };
  });

  app.get<{ Params: { channel: string } }>("/bp/v2/presence/:channel", async (req, reply) => {
    if (!CHANNEL.test(req.params.channel)) return reply.code(400).send({ error: "bad_channel" });
    return { members: await listChannel(req.params.channel) };
  });

  // ---- ws fan-out --------------------------------------------------------
  app.get<{ Querystring: { channel?: string; since_seq?: string } }>(
    "/bp/v2/ws", { websocket: true },
    (socket, req) => {
      const channel = req.query.channel ?? "";
      if (!CHANNEL.test(channel)) { socket.close(1008, "bad_channel"); return; }
      const since = Number(req.query.since_seq ?? 0) | 0;

      // Replay missed messages before switching to live stream.
      for (const m of replay(channel, since)) {
        try { socket.send(JSON.stringify(m)); } catch { /* closed */ }
      }
      const unsub = subscribe(channel, (msg) => {
        try { socket.send(JSON.stringify(msg)); } catch { /* closed */ }
      });
      socket.on("close", unsub);
    },
  );

  // ---- diagnostics -------------------------------------------------------
  app.get("/bp/v2/stats", async () => _stats());

  // Bridge for external backplane deliveries (used by NATS subscriber wiring
  // when configured; exposed as an internal HTTP for testability).
  app.post("/bp/v2/_internal/deliver", async (req, reply) => {
    const body = z.object({
      channel: z.string().regex(CHANNEL),
      event:   z.string(),
      payload: z.unknown().default({}),
      sender_id: z.string().nullable().optional(),
      created_at: z.number().int().optional(),
      expires_at: z.number().int().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const now = Date.now();
    const msg = deliverFromBackplane({
      channel: body.data.channel, event: body.data.event, payload: body.data.payload,
      sender_id: body.data.sender_id ?? null,
      created_at: body.data.created_at ?? now,
      expires_at: body.data.expires_at ?? now + 30_000,
    });
    return { ok: true, seq: msg.seq };
  });
}
