// Phase 51 — Realtime v4 plugin.
//
// Endpoints (all under /rt/v4):
//   POST /rt/v4/presence/apply     — apply a CRDT mutation (set/remove)
//   POST /rt/v4/presence/merge     — merge a remote state snapshot
//   GET  /rt/v4/presence/:channel  — resolved live members + version vector
//   POST /rt/v4/queue/enqueue      — buffer an event for an offline subscriber
//   GET  /rt/v4/queue/drain        — drain buffered events (?since_seq=N)
//   POST /rt/v4/queue/ack          — acknowledge received events up to seq
//   POST /rt/v4/delta/encode       — encode payload against per-topic baseline
//   POST /rt/v4/delta/decode       — decode a delta envelope against baseline
//
// The plugin activates only when PLUTO_ENABLE_REALTIME_V4=1.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../../lib/apikey.js";
import { apply, merge, members, empty, type PresenceEntry, type PresenceState } from "../../lib/presence-crdt.js";
import { enqueue, drain, ack, size } from "../../lib/offline-queue.js";
import { encodeDelta, decodeDelta, hashPayload, type DeltaEnvelope } from "../../lib/delta-codec.js";

const enabled = process.env.PLUTO_ENABLE_REALTIME_V4 === "1";
const CHAN = /^[a-z0-9_:.\-]{1,128}$/i;

// In-process CRDT registry — one PresenceState per channel. Multi-node
// deployments should periodically merge remote snapshots via the merge
// endpoint (or over the NATS backplane) to converge.
const states = new Map<string, PresenceState>();
// Per-topic delta baselines. Cleared with the baseline endpoint.
const baselines = new Map<string, unknown>();
const bKey = (channel: string, topic: string) => `${channel}::${topic}`;

const HlcSchema = z.object({ ts: z.number().int().nonnegative(), ctr: z.number().int().nonnegative(), actor: z.string().min(1) });

export async function realtimeV4Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);

  // ---- presence CRDT -----------------------------------------------------
  app.post("/rt/v4/presence/apply", async (req, reply) => {
    const schema = z.object({
      channel: z.string().regex(CHAN),
      actor: z.string().min(1).max(128),
      hlc: HlcSchema,
      metadata: z.record(z.unknown()).optional(),
      tombstone: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "bad_request", issues: parsed.error.issues }; }
    const { channel, actor, hlc, metadata, tombstone } = parsed.data;
    const state = states.get(channel) ?? empty();
    const entry: PresenceEntry = { actor, hlc, metadata: metadata ?? {}, tombstone: tombstone ?? false };
    const changed = apply(state, entry);
    states.set(channel, state);
    return { ok: true, changed, size: members(state).length };
  });

  app.post("/rt/v4/presence/merge", async (req, reply) => {
    const schema = z.object({
      channel: z.string().regex(CHAN),
      entries: z.array(z.object({
        actor: z.string().min(1),
        hlc: HlcSchema,
        metadata: z.record(z.unknown()).optional(),
        tombstone: z.boolean().optional(),
      })),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "bad_request", issues: parsed.error.issues }; }
    const remote: PresenceState = new Map();
    for (const e of parsed.data.entries) {
      remote.set(e.actor, { actor: e.actor, hlc: e.hlc, metadata: e.metadata ?? {}, tombstone: e.tombstone ?? false });
    }
    const cur = states.get(parsed.data.channel) ?? empty();
    const merged = merge(cur, remote);
    states.set(parsed.data.channel, merged);
    return { ok: true, size: members(merged).length };
  });

  app.get("/rt/v4/presence/:channel", async (req, reply) => {
    const channel = (req.params as { channel: string }).channel;
    if (!CHAN.test(channel)) { reply.code(400); return { error: "bad_channel" }; }
    const state = states.get(channel) ?? empty();
    return {
      channel,
      members: members(state),
      version: [...state.values()].map((e) => ({ actor: e.actor, hlc: e.hlc })),
    };
  });

  // ---- offline queue -----------------------------------------------------
  app.post("/rt/v4/queue/enqueue", async (req, reply) => {
    const schema = z.object({
      channel: z.string().regex(CHAN),
      subscriber: z.string().min(1).max(128),
      event: z.string().min(1).max(128),
      payload: z.unknown(),
      is_delta: z.boolean().optional(),
      base_hash: z.string().nullable().optional(),
      ttl_ms: z.number().int().positive().max(24 * 60 * 60_000).optional(),
    });
    const p = schema.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const item = enqueue(p.data);
    return { ok: true, item, queue_size: size(p.data.channel, p.data.subscriber) };
  });

  app.get("/rt/v4/queue/drain", async (req, reply) => {
    const q = z.object({
      channel: z.string().regex(CHAN),
      subscriber: z.string().min(1),
      since_seq: z.coerce.number().int().nonnegative().optional(),
    }).safeParse(req.query);
    if (!q.success) { reply.code(400); return { error: "bad_request", issues: q.error.issues }; }
    const items = drain(q.data.channel, q.data.subscriber, q.data.since_seq ?? 0);
    return { channel: q.data.channel, subscriber: q.data.subscriber, items };
  });

  app.post("/rt/v4/queue/ack", async (req, reply) => {
    const p = z.object({
      channel: z.string().regex(CHAN),
      subscriber: z.string().min(1),
      upto_seq: z.number().int().nonnegative(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const removed = ack(p.data.channel, p.data.subscriber, p.data.upto_seq);
    return { ok: true, removed, remaining: size(p.data.channel, p.data.subscriber) };
  });

  // ---- delta codec -------------------------------------------------------
  app.post("/rt/v4/delta/encode", async (req, reply) => {
    const p = z.object({
      channel: z.string().regex(CHAN),
      topic: z.string().min(1).max(128),
      payload: z.unknown(),
      update_baseline: z.boolean().optional(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const key = bKey(p.data.channel, p.data.topic);
    const baseline = baselines.get(key) ?? null;
    const env = encodeDelta(baseline, p.data.payload);
    if (p.data.update_baseline ?? true) baselines.set(key, p.data.payload);
    return {
      envelope: env,
      encoded_bytes: Buffer.byteLength(JSON.stringify(env)),
      full_bytes: Buffer.byteLength(JSON.stringify(p.data.payload)),
      new_hash: hashPayload(p.data.payload),
    };
  });

  app.post("/rt/v4/delta/decode", async (req, reply) => {
    const p = z.object({
      baseline: z.unknown().nullable(),
      envelope: z.object({
        base_hash: z.string().nullable(),
        full: z.unknown().optional(),
        ops: z.array(z.object({
          op: z.enum(["set", "del"]),
          path: z.string(),
          value: z.unknown().optional(),
        })).optional(),
      }),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    try {
      const result = decodeDelta(p.data.baseline ?? null, p.data.envelope as DeltaEnvelope);
      return { ok: true, payload: result };
    } catch (e) {
      reply.code(409);
      return { error: "decode_failed", message: (e as Error).message };
    }
  });
}
