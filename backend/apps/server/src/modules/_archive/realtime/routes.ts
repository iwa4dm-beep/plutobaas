// Realtime — WebSocket fan-out backed by Postgres LISTEN/NOTIFY.
//
// Client protocol (JSON messages over one WS connection):
//   → { type: "subscribe",   channel: "public:notes" }
//   → { type: "subscribe",   channel: "public:notes:user_id=eq.<uuid>" }
//   → { type: "unsubscribe", channel: "..." }
//   → { type: "broadcast",   channel: "chat:room-1", event: "msg", payload: {...} }
//   ← { type: "change",      channel, event: "INSERT|UPDATE|DELETE", record }
//   ← { type: "broadcast",   channel, event, payload }
//
// Postgres side: `public.pluto_enable_realtime('public.notes')` installs a
// trigger that fires `pg_notify('pluto_changes', ...)`. This module has ONE
// persistent LISTEN connection and fans events out to matching subscribers.

import type { FastifyInstance } from "fastify";
import pg from "pg";
import { env } from "../../../config.js";
import { verifyAccessToken } from "../../../lib/jwt.js";

type Sub = { channel: string; filter?: { col: string; value: string } };
type Client = {
  send: (data: string) => void;
  subs: Sub[];
  userId: string | null;
  isAdmin: boolean;          // service_role key + JWT with role=admin
};

const clients = new Set<Client>();

async function startListener() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query("listen pluto_changes");
  await client.query("listen pluto_broadcast");
  client.on("notification", (msg) => {
    if (!msg.payload) return;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(msg.payload); } catch { return; }

    if (msg.channel === "pluto_broadcast") {
      const { channel, event, payload } = evt as { channel: string; event: string; payload: unknown };
      const wire = JSON.stringify({ type: "broadcast", channel, event, payload });
      for (const c of clients) if (c.subs.some((s) => s.channel === channel)) c.send(wire);
      return;
    }

    const { schema, table, type, record } = evt as {
      schema: string; table: string; type: string; record: Record<string, unknown>;
    };
    const chan = `${schema}:${table}`;
    for (const c of clients) {
      for (const s of c.subs) {
        if (s.channel !== chan) continue;
        if (s.filter && String(record[s.filter.col]) !== s.filter.value) continue;
        c.send(JSON.stringify({ type: "change", channel: s.channel, event: type, record }));
      }
    }
  });
  client.on("error", (e) => { console.error("[realtime] pg error", e); });
}

function parseChannel(input: string): Sub | null {
  // "public:notes"                 → whole table
  // "public:notes:user_id=eq.<v>"  → filtered
  const parts = input.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const channel = `${parts[0]}:${parts[1]}`;
  if (parts.length === 2) return { channel };
  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)=eq\.(.+)$/.exec(parts[2]);
  if (!m) return null;
  return { channel, filter: { col: m[1], value: m[2] } };
}

export async function realtimeRoutes(app: FastifyInstance) {
  await startListener().catch((e) => app.log.error({ e }, "realtime listener failed"));

  const handler = async (socket: any, req: any) => {
    const url = new URL(req.url, "http://x");
    const apikey = url.searchParams.get("apikey");
    if (apikey !== env.ANON_KEY && apikey !== env.SERVICE_ROLE_KEY) {
      socket.close(1008, "invalid_api_key"); return;
    }
    const isServiceRole = apikey === env.SERVICE_ROLE_KEY;

    let userId: string | null = null;
    let role: string | null = null;
    const token = url.searchParams.get("access_token");
    if (token) {
      try {
        const claims = await verifyAccessToken(token);
        userId = claims.sub; role = claims.role;
      } catch { /* anonymous */ }
    }

    // A "system:*" broadcast is admin-only. It carries privileged
    // audit and migration progress payloads that anon/regular users
    // must never see. Enforce at BOTH connect time (fast reject) and
    // per-subscribe time (defence in depth).
    const isAdmin = isServiceRole && role === "admin";

    const client: Client = {
      send: (d) => { try { socket.send(d); } catch { /* closed */ } },
      subs: [],
      userId,
      isAdmin,
    };
    clients.add(client);
    client.send(JSON.stringify({ type: "ready", admin: isAdmin }));

    const initialChannel = url.searchParams.get("channel");
    if (initialChannel) {
      const s = parseChannel(initialChannel.includes(":") ? initialChannel : `public:${initialChannel}`);
      if (s) {
        client.subs.push(s);
        client.send(JSON.stringify({ type: "subscribed", channel: initialChannel, status: "SUBSCRIBED" }));
      }
    }

    socket.on("message", async (raw: Buffer) => {
      let msg: { type?: string; channel?: string; event?: string; payload?: unknown };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "subscribe" && msg.channel) {
        if (msg.channel.startsWith("system:") && !client.isAdmin) {
          // Distinguish "you need the service_role key" from "you have
          // the key but your JWT doesn't carry role=admin". The UI
          // uses this to render the correct fix instructions and to
          // STOP retrying until credentials change.
          const code = !isServiceRole ? "admin_required" : "admin_role_required";
          client.send(JSON.stringify({ type: "error", channel: msg.channel, error: code, fatal: true }));
          // Close with a policy-violation code so the client's
          // reconnect logic can back off permanently.
          try { socket.close(1008, code); } catch { /* already closed */ }
          return;
        }

        const s = parseChannel(msg.channel);
        if (!s) return client.send(JSON.stringify({ type: "error", error: "bad_channel" }));
        client.subs.push(s);
        client.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
      } else if (msg.type === "unsubscribe" && msg.channel) {
        client.subs = client.subs.filter((s) => s.channel !== parseChannel(msg.channel!)?.channel);
      } else if (msg.type === "broadcast" && msg.channel && msg.event) {
        // Never let clients spoof system:* traffic; only server-side
        // `emit()` helpers may write to those channels.
        if (msg.channel.startsWith("system:")) {
          return client.send(JSON.stringify({ type: "error", error: "system_channel_readonly" }));
        }
        const pgClient = new pg.Client({ connectionString: env.DATABASE_URL });
        await pgClient.connect();
        await pgClient.query("select pg_notify('pluto_broadcast', $1)", [
          JSON.stringify({ channel: msg.channel, event: msg.event, payload: msg.payload ?? null, from: userId }),
        ]);
        await pgClient.end();
      }
    });

    socket.on("close", () => clients.delete(client));
  };

  // Register both forms because browser clients commonly open
  // /realtime/v1?apikey=... without a trailing slash.
  app.get("/realtime/v1", { websocket: true }, handler);
  app.get("/realtime/v1/", { websocket: true }, handler);
}
