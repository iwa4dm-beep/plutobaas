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

function parsePgFilter(raw: unknown): PgSub['filter'] | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.+)$/);
  if (!m) return undefined;
  return { column: m[1], op: 'eq', value: decodeURIComponent(m[2]) };
}

function normalizePgSubs(input: unknown): PgSub[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item): PgSub | null => {
      if (!item || typeof item !== 'object') return null;
      const v = item as Record<string, unknown>;
      const eventRaw = String(v.event ?? '*').toUpperCase();
      const event: PgSub['event'] = eventRaw === 'INSERT' || eventRaw === 'UPDATE' || eventRaw === 'DELETE' ? eventRaw : '*';
      return {
        event,
        schema: typeof v.schema === 'string' ? v.schema : '*',
        table: typeof v.table === 'string' ? v.table : '*',
        filter: parsePgFilter(v.filter),
      };
    })
    .filter((v): v is PgSub => !!v);
}

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

  const websocketHandler = (socket: any, req: any) => {
    const connId = randomUUID();
    const subs = new Map<string, ChannelSub>(); // topic -> sub
    const disposers: Array<() => void> = [];
    let userId: string | null = null;
    let role: 'anon' | 'authenticated' | 'service_role' = 'anon';
    const url = new URL(req.url ?? '/', 'http://x');

    const addSubscription = (topic: string, cfgSub: any = {}, ref?: unknown) => {
      if (!topic) {
        send({ type: 'error', ref, message: 'topic required' });
        return;
      }
      if (subs.has(topic)) {
        send({ type: 'subscribed', event: 'SUBSCRIBED', status: 'SUBSCRIBED', ref, topic, channel: topic });
        return;
      }
      const sub: ChannelSub = {
        topic,
        pg: normalizePgSubs(cfgSub.postgres_changes),
        broadcast: cfgSub.broadcast === false ? null : { self: !!cfgSub.broadcast?.self },
        presence: cfgSub.presence ? { key: String(cfgSub.presence.key || userId || connId) } : null,
      };

      // Broadcast listener per topic. Enabled by default for query-param
      // subscriptions so Supabase-style clients that open
      // /realtime/v1?channel=<topic> are actually attached immediately.
      if (sub.broadcast) {
        const evName = `broadcast:${topic}`;
        const handler = (b: BroadcastMsg) => {
          if (!sub.broadcast!.self && b.sender === connId) return;
          send({ type: 'broadcast', event: b.event, topic, channel: topic, payload: b.payload });
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
            event: 'presence_diff',
            topic,
            channel: topic,
            joins: e.event === 'join' ? { [e.id]: e.state } : {},
            leaves: e.event === 'leave' ? { [e.id]: e.state } : {},
          });
        };
        hub.on(evName, handler);
        disposers.push(() => hub.off(evName, handler));
        // initial snapshot
        send({ type: 'presence_state', event: 'presence_state', topic, channel: topic, state: hub.presenceSnapshot(topic) });
      }

      subs.set(topic, sub);
      send({ type: 'subscribed', event: 'SUBSCRIBED', status: 'SUBSCRIBED', ref, topic, channel: topic });
    };

    // Best-effort auth via ?apikey= or ?access_token=
    (async () => {
      const token = url.searchParams.get('access_token') || url.searchParams.get('apikey') || '';
      if (token) {
        try {
          const decoded: any = await app.jwt.verify(token);
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
            send({ type: 'postgres_changes', event: p.type, topic: sub.topic, channel: sub.topic, payload: p });
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
          addSubscription(topic, msg.config || {}, msg.ref);
          return;
        }

        case 'unsubscribe': {
          subs.delete(String(msg.topic || ''));
          return send({ type: 'unsubscribed', ref: msg.ref, topic: msg.topic });
        }

        case 'broadcast': {
          const topic = String(msg.topic || msg.channel || '');
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
    const initialChannel = url.searchParams.get('channel');
    if (initialChannel) addSubscription(initialChannel, { broadcast: { self: true } }, 'query');
  };

  // Support both Supabase-style /realtime/v1 and explicit /realtime/v1/websocket.
  app.get('/realtime/v1', { websocket: true }, websocketHandler);
  app.get('/realtime/v1/websocket', { websocket: true }, websocketHandler);

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
