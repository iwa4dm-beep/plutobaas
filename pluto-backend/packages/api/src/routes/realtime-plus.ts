// Realtime extensions: presence tracking, LISTEN/NOTIFY broadcast REST publish,
// per-row subscription filters, channel management.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const channelBody = z.object({
  project_id: z.string().uuid(),
  topic: z.string().min(1).max(200),
  private: z.boolean().default(false),
  max_presence: z.number().int().min(1).max(10_000).default(500),
});

const publishBody = z.object({
  project_id: z.string().uuid(),
  topic: z.string().min(1),
  event: z.string().min(1),
  payload: z.record(z.any()).default({}),
  persist: z.boolean().default(false),
});

const presenceBody = z.object({
  project_id: z.string().uuid(),
  topic: z.string().min(1),
  presence_key: z.string().min(1),
  meta: z.record(z.any()).default({}),
});

export async function realtimePlusRoutes(app: FastifyInstance, cfg: Config) {
  // ---------- Channels ----------
  app.get('/realtime/v1/channels', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return getSql(cfg)`select * from realtime.channels where project_id = ${q.project_id} order by topic`;
  });

  app.post('/realtime/v1/channels', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = channelBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into realtime.channels (project_id, topic, private, max_presence)
      values (${body.project_id}, ${body.topic}, ${body.private}, ${body.max_presence})
      on conflict (project_id, topic) do update
        set private = excluded.private, max_presence = excluded.max_presence
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'realtime.channel.upsert', target: `${body.project_id}:${body.topic}` });
    reply.code(201).send(row);
  });

  app.delete('/realtime/v1/channels/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from realtime.channels where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'realtime.channel.delete', target: id });
    reply.code(204).send();
  });

  // ---------- Publish (REST → NOTIFY → WS hub) ----------
  app.post('/realtime/v1/publish', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = publishBody.parse(req.body);
    const sql = getSql(cfg);
    const chan = `pluto_broadcast_${body.project_id.replace(/-/g, '')}`;
    const notifyPayload = JSON.stringify({ topic: body.topic, event: body.event, payload: body.payload });
    // pg_notify has 8000 byte limit; guard.
    if (Buffer.byteLength(notifyPayload) > 7500) {
      reply.code(413).send({ error: 'payload_too_large', limit: 7500 });
      return;
    }
    await sql`select pg_notify(${chan}, ${notifyPayload})`;
    if (body.persist) {
      await sql`insert into realtime.broadcasts (project_id, topic, event, payload) values (${body.project_id}, ${body.topic}, ${body.event}, ${body.payload as any})`;
    }
    await logAudit(cfg, { actor_id: actor.userId, action: 'realtime.publish', target: `${body.project_id}:${body.topic}`, detail: { event: body.event } });
    return { ok: true };
  });

  app.get('/realtime/v1/history', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({
      project_id: z.string().uuid(),
      topic: z.string(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    return getSql(cfg)`
      select id, event, payload, sent_at
      from realtime.broadcasts
      where project_id = ${q.project_id} and topic = ${q.topic}
      order by sent_at desc limit ${q.limit}`;
  });

  // ---------- Presence ----------
  app.get('/realtime/v1/presence', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid(), topic: z.string() }).parse(req.query);
    return getSql(cfg)`
      select presence_key, user_id, meta, last_seen_at
      from realtime.presence
      where project_id = ${q.project_id} and topic = ${q.topic}
      order by last_seen_at desc`;
  });

  app.post('/realtime/v1/presence/track', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = presenceBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into realtime.presence (project_id, topic, presence_key, user_id, meta, last_seen_at)
      values (${body.project_id}, ${body.topic}, ${body.presence_key}, ${actor.userId}, ${body.meta as any}, now())
      on conflict (project_id, topic, presence_key)
      do update set meta = excluded.meta, last_seen_at = now(), user_id = excluded.user_id
      returning *`;
    return row;
  });

  app.post('/realtime/v1/presence/untrack', async (req) => {
    await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(), topic: z.string(), presence_key: z.string(),
    }).parse(req.body);
    await getSql(cfg)`
      delete from realtime.presence
      where project_id = ${body.project_id} and topic = ${body.topic} and presence_key = ${body.presence_key}`;
    return { ok: true };
  });

  // Sweep stale presence (>60s no heartbeat).
  app.post('/realtime/v1/presence/sweep', async (req) => {
    await requireAuth(req, cfg);
    const r = await getSql(cfg)`delete from realtime.presence where last_seen_at < now() - interval '60 seconds' returning id`;
    return { removed: r.length };
  });
}
