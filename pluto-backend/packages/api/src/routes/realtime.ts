import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { getHub, type PostgresChangePayload, type BroadcastMsg } from '../realtime/hub.js';

/**
 * Realtime protocol — Supabase-compatible-ish JSON frames:
 *
 * Client -> Server:
 *   { type: 'subscribe', ref, topic, config?: {
 *       postgres_changes?: [{ event: '*'|'INSERT'|'UPDATE'|'DELETE', schema, table, filter? }],
 *       broadcast?: { self?: boolean },
 *       presence?: { key?: string },
 *   }}
 *   { type: 'unsubscribe', ref, topic }
 *   { type: 'broadcast', topic, event, payload }
 *   { type: 'presence', topic, event: 'track'|'untrack', payload? }
 *   { type: 'heartbeat' }
 *
 * Server -> Client:
 *   { type: 'subscribed', ref, topic }
 *   { type: 'postgres_changes', topic, payload }
 *   { type: 'broadcast', topic, event, payload }
 *   { type: 'presence_state', topic, state }
 *   { type: 'presence_diff', topic, joins, leaves }
 *   { type: 'error', ref?, message }
 *   { type: 'pong' }
 */

type PgSub = {
  event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  schema?: string;
  table?: string;
  filter?: { column: string; op: 'eq'; value: string };
};

type ChannelSub = {
  topic: string;
  pg: PgSub[];
  broadcast: { self: boolean } | null;
  presence: { key: string } | null;
};

function matchFilter(row: Record<string, any> | null, f?: PgSub['filter']): boolean {
  if (!f || !row) return true;
  return String(row[f.column]) === String(f.value);
}

function matchPg(sub: PgSub, p: PostgresChangePayload): boolean {
  if (sub.schema && sub.schema !== '*' && sub.schema !== p.schema) return false;
  if (sub.table && sub.table !== '*' && sub.table !== p.table) return false;
  if (sub.event !== '*' && sub.event !== p.type) return false;
  return matchFilter(p.record ?? p.old, sub.filter);
}

export async function realtimeRoutes(app: FastifyInstance, cfg: Config) {
  await app.register(websocket);
  const hub = getHub();
  try {
    await hub.start(cfg);
  } catch (e: any) {
    app.log.warn({ err: e.message }, 'realtime: pg LISTEN not available');
  }

  app.get('/realtime/v1/websocket', { websocket: true }, (socket, req) => {
    const connId = randomUUID();
    const subs = new Map<string, ChannelSub>(); // topic -> sub
    const disposers: Array<() => void> = [];
    let userId: string | null = null;
    let role: 'anon' | 'authenticated' | 'service_role' = 'anon';

    // Best-effort auth via ?apikey= or ?access_token=
    (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const token = url.searchParams.get('access_token') || url.searchParams.get('apikey') || '';
      if (token) {
        try {
          const decoded: any = app.jwt.verify(token);
          userId = decoded?.sub ?? null;
          role = decoded?.role === 'service_role' ? 'service_role' : 'authenticated';
        } catch { /* ignore, stays anon */ }
      }
    })();

    const send = (obj: any) => {
      try { socket.send(JSON.stringify(obj)); } catch {}
    };

    // Global postgres_changes fanout
    const onPg = (p: PostgresChangePayload) => {
      for (const sub of subs.values()) {
        for (const rule of sub.pg) {
          if (matchPg(rule, p)) {
            send({ type: 'postgres_changes', topic: sub.topic, payload: p });
            break;
          }
        }
      }
    };
    hub.on('postgres_changes', onPg);
    disposers.push(() => hub.off('postgres_changes', onPg));

    socket.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); }
      catch { return send({ type: 'error', message: 'invalid JSON' }); }

      switch (msg.type) {
        case 'heartbeat':
          return send({ type: 'pong' });

        case 'subscribe': {
          const topic = String(msg.topic || '');
          if (!topic) return send({ type: 'error', ref: msg.ref, message: 'topic required' });
          const cfgSub = msg.config || {};
          const sub: ChannelSub = {
            topic,
            pg: Array.isArray(cfgSub.postgres_changes) ? cfgSub.postgres_changes : [],
            broadcast: cfgSub.broadcast ? { self: !!cfgSub.broadcast.self } : null,
            presence: cfgSub.presence ? { key: String(cfgSub.presence.key || userId || connId) } : null,
          };

          // Broadcast listener per topic
          if (sub.broadcast) {
            const evName = `broadcast:${topic}`;
            const handler = (b: BroadcastMsg) => {
              if (!sub.broadcast!.self && b.sender === connId) return;
              send({ type: 'broadcast', topic, event: b.event, payload: b.payload });
            };
            hub.on(evName, handler);
            disposers.push(() => hub.off(evName, handler));
          }

          // Presence listener
          if (sub.presence) {
            const evName = `presence:${topic}`;
            const handler = (e: any) => {
              send({
                type: 'presence_diff',
                topic,
                joins: e.event === 'join' ? { [e.id]: e.state } : {},
                leaves: e.event === 'leave' ? { [e.id]: e.state } : {},
              });
            };
            hub.on(evName, handler);
            disposers.push(() => hub.off(evName, handler));
            // initial snapshot
            send({ type: 'presence_state', topic, state: hub.presenceSnapshot(topic) });
          }

          subs.set(topic, sub);
          return send({ type: 'subscribed', ref: msg.ref, topic });
        }

        case 'unsubscribe': {
          subs.delete(String(msg.topic || ''));
          return send({ type: 'unsubscribed', ref: msg.ref, topic: msg.topic });
        }

        case 'broadcast': {
          const topic = String(msg.topic || '');
          if (!subs.has(topic)) return send({ type: 'error', message: 'not subscribed' });
          hub.broadcast({ channel: topic, event: String(msg.event || 'message'), payload: msg.payload, sender: connId });
          return;
        }

        case 'presence': {
          const topic = String(msg.topic || '');
          const sub = subs.get(topic);
          if (!sub?.presence) return send({ type: 'error', message: 'presence not enabled' });
          const id = sub.presence.key;
          if (msg.event === 'track') hub.presenceJoin(topic, id, msg.payload ?? {});
          else if (msg.event === 'untrack') hub.presenceLeave(topic, id);
          return;
        }

        default:
          return send({ type: 'error', message: `unknown type: ${msg.type}` });
      }
    });

    socket.on('close', () => {
      for (const sub of subs.values()) {
        if (sub.presence) hub.presenceLeave(sub.topic, sub.presence.key);
      }
      for (const d of disposers) d();
      subs.clear();
    });

    // Greet
    send({ type: 'connected', connId, role, userId });
  });

  // Simple HTTP broadcast (for server-side triggers)
  app.post<{ Body: { channel: string; event: string; payload: any } }>(
    '/realtime/v1/broadcast',
    async (req, reply) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Unauthorized' });
      try { await (req as any).jwtVerify(); }
      catch { return reply.code(401).send({ error: 'Invalid token' }); }

      const { channel, event, payload } = req.body || ({} as any);
      if (!channel || !event) return reply.code(400).send({ error: 'channel and event required' });
      hub.broadcast({ channel, event, payload });
      return reply.send({ ok: true });
    },
  );

  app.get('/realtime/v1/health', async () => ({ ok: true, service: 'realtime' }));
}
