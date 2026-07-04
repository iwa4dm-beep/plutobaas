// Phase 48 — Presence & session store.
//
// Redis-first with an in-memory + database fallback so single-instance
// deployments Just Work. The public surface is deliberately small: heartbeat,
// join/leave, list-by-channel, and prune. All mutations emit deltas that the
// broadcast bus fans out to subscribers as join/leave events.
//
// Redis is loaded via dynamic import — the dependency is optional.

import { randomUUID } from "node:crypto";

export type PresenceEntry = {
  session_id: string;
  user_id: string | null;
  channel: string;
  state: Record<string, unknown>;
  joined_at: number;   // epoch ms
  expires_at: number;  // epoch ms
};

export type PresenceDelta =
  | { type: "join";  channel: string; entry: PresenceEntry }
  | { type: "leave"; channel: string; session_id: string; user_id: string | null };

type RedisLike = {
  set: (key: string, value: string, opts?: { PX?: number }) => Promise<unknown>;
  del: (key: string | string[]) => Promise<unknown>;
  keys: (pattern: string) => Promise<string[]>;
  mGet: (keys: string[]) => Promise<Array<string | null>>;
  expire: (key: string, seconds: number) => Promise<unknown>;
};

const PREFIX = process.env.PLUTO_PRESENCE_PREFIX ?? "pluto:presence";
const HEARTBEAT_TTL_MS = Number(process.env.PLUTO_PRESENCE_TTL_MS ?? 60_000);

let redis: RedisLike | null = null;
let redisConnecting: Promise<RedisLike | null> | null = null;
const memory = new Map<string, PresenceEntry>(); // key = `${channel}::${session_id}`

async function getRedis(): Promise<RedisLike | null> {
  if (process.env.PLUTO_ENABLE_REDIS !== "1") return null;
  if (redis) return redis;
  if (redisConnecting) return redisConnecting;
  redisConnecting = (async () => {
    try {
      const mod = (await import("redis" as string).catch(() => null)) as
        | { createClient: (opts: { url: string }) => RedisLike & { connect: () => Promise<void> } }
        | null;
      if (!mod) return null;
      const c = mod.createClient({ url: process.env.PLUTO_REDIS_URL ?? "redis://localhost:6379" });
      await c.connect();
      redis = c;
      return c;
    } catch { return null; } finally { redisConnecting = null; }
  })();
  return redisConnecting;
}

function keyFor(channel: string, session_id: string) {
  return `${PREFIX}:${channel}::${session_id}`;
}

export function newSessionId() { return randomUUID(); }

export async function heartbeat(
  channel: string,
  session_id: string,
  user_id: string | null,
  state: Record<string, unknown> = {},
): Promise<{ entry: PresenceEntry; joined: boolean }> {
  const now = Date.now();
  const k = keyFor(channel, session_id);
  const existing = await getEntry(channel, session_id);
  const joined = !existing;
  const entry: PresenceEntry = {
    session_id, user_id, channel, state,
    joined_at: existing?.joined_at ?? now,
    expires_at: now + HEARTBEAT_TTL_MS,
  };
  const r = await getRedis();
  if (r) await r.set(k, JSON.stringify(entry), { PX: HEARTBEAT_TTL_MS });
  else memory.set(k, entry);
  return { entry, joined };
}

export async function leave(channel: string, session_id: string): Promise<PresenceEntry | null> {
  const existing = await getEntry(channel, session_id);
  const k = keyFor(channel, session_id);
  const r = await getRedis();
  if (r) await r.del(k); else memory.delete(k);
  return existing;
}

export async function getEntry(channel: string, session_id: string): Promise<PresenceEntry | null> {
  const k = keyFor(channel, session_id);
  const r = await getRedis();
  if (r) {
    const vals = await r.mGet([k]);
    const raw = vals[0];
    return raw ? (JSON.parse(raw) as PresenceEntry) : null;
  }
  const v = memory.get(k);
  if (!v) return null;
  if (v.expires_at < Date.now()) { memory.delete(k); return null; }
  return v;
}

export async function listChannel(channel: string): Promise<PresenceEntry[]> {
  const r = await getRedis();
  if (r) {
    const ks = await r.keys(`${PREFIX}:${channel}::*`);
    if (!ks.length) return [];
    const vals = await r.mGet(ks);
    return vals.filter((v): v is string => !!v).map((v) => JSON.parse(v) as PresenceEntry);
  }
  const now = Date.now();
  const out: PresenceEntry[] = [];
  for (const [k, v] of memory) {
    if (!k.startsWith(`${PREFIX}:${channel}::`)) continue;
    if (v.expires_at < now) { memory.delete(k); continue; }
    out.push(v);
  }
  return out;
}

// Prune expired in-memory entries. Redis handles its own TTL via PX.
export function pruneMemory(): number {
  const now = Date.now();
  let n = 0;
  for (const [k, v] of memory) if (v.expires_at < now) { memory.delete(k); n++; }
  return n;
}

// Test helper — full reset.
export function _resetPresenceForTests() { memory.clear(); }
