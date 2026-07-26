/**
 * Durable webhook idempotency store + recent-events log.
 *
 * Backends (chosen at runtime from env, in this order):
 *   1. Redis  — set `PLUTO_WEBHOOK_REDIS_URL=redis://…`
 *   2. File   — set `PLUTO_WEBHOOK_IDEMPOTENCY_FILE=/absolute/path.json`
 *               (defaults to `<cwd>/.pluto/webhook-events.json`)
 *
 * TTL is configurable via `PLUTO_WEBHOOK_IDEMPOTENCY_TTL_MS`
 * (default 24h). Tests can set a low value for fast expiry checks.
 *
 * Also exposes an in-memory ring buffer of recent event outcomes
 * (accepted / duplicate / rejected) for the /debug/webhooks page.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const HOT_CACHE_LIMIT = 1000;
const RECENT_LIMIT = 200;

export function ttlMs(): number {
  const raw = process.env.PLUTO_WEBHOOK_IDEMPOTENCY_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

type Entry = { at: number };
type Store = {
  has: (id: string) => Promise<boolean>;
  put: (id: string) => Promise<void>;
  size: () => Promise<number>;
  backend: "redis" | "file";
};

// ── Hot cache (per-process, cleared on restart or via resetHotCache) ─────────
const hot: Map<string, Entry> =
  (globalThis as any).__plutoWebhookHot ?? new Map<string, Entry>();
(globalThis as any).__plutoWebhookHot = hot;

function hotHas(id: string): boolean {
  const e = hot.get(id);
  if (!e) return false;
  if (Date.now() - e.at > ttlMs()) {
    hot.delete(id);
    return false;
  }
  return true;
}
function hotPut(id: string) {
  hot.set(id, { at: Date.now() });
  while (hot.size > HOT_CACHE_LIMIT) {
    const k = hot.keys().next().value;
    if (!k) break;
    hot.delete(k);
  }
}
export function resetHotCache() {
  hot.clear();
}

// ── File backend ────────────────────────────────────────────────────────────
function filePath(): string {
  return (
    process.env.PLUTO_WEBHOOK_IDEMPOTENCY_FILE ||
    path.join(process.cwd(), ".pluto", "webhook-events.json")
  );
}

async function fileRead(): Promise<Record<string, number>> {
  try {
    const raw = await fs.readFile(filePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function fileWrite(data: Record<string, number>) {
  const p = filePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, p);
}

function sweep(data: Record<string, number>): Record<string, number> {
  const now = Date.now();
  const ttl = ttlMs();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "number" && now - v <= ttl) out[k] = v;
  }
  return out;
}

const fileStore: Store = {
  backend: "file",
  async has(id) {
    const data = await fileRead();
    const at = data[id];
    return typeof at === "number" && Date.now() - at <= ttlMs();
  },
  async put(id) {
    const data = sweep(await fileRead());
    data[id] = Date.now();
    await fileWrite(data);
  },
  async size() {
    return Object.keys(sweep(await fileRead())).length;
  },
};

// ── Redis backend ───────────────────────────────────────────────────────────
let redisStore: Store | null = null;
async function tryRedis(): Promise<Store | null> {
  const url = process.env.PLUTO_WEBHOOK_REDIS_URL;
  if (!url) return null;
  if (redisStore) return redisStore;
  try {
    const mod: any = await import("ioredis").catch(() => null);
    if (!mod) return null;
    const Redis = mod.default ?? mod.Redis ?? mod;
    const client = new Redis(url);
    const prefix = process.env.PLUTO_WEBHOOK_REDIS_PREFIX ?? "pluto:webhook:seen:";
    redisStore = {
      backend: "redis",
      async has(id) {
        return (await client.exists(prefix + id)) === 1;
      },
      async put(id) {
        await client.set(prefix + id, "1", "PX", ttlMs());
      },
      async size() {
        const n = await client.dbsize();
        return typeof n === "number" ? n : 0;
      },
    };
    return redisStore;
  } catch {
    return null;
  }
}

async function getStore(): Promise<Store> {
  return (await tryRedis()) ?? fileStore;
}

/**
 * Returns true if this is the first time we see `id`.
 */
export async function claimEventId(id: string): Promise<{ fresh: boolean; backend: Store["backend"] }> {
  const store = await getStore();
  if (hotHas(id)) return { fresh: false, backend: store.backend };
  if (await store.has(id)) {
    hotPut(id);
    return { fresh: false, backend: store.backend };
  }
  await store.put(id);
  hotPut(id);
  return { fresh: true, backend: store.backend };
}

export async function idempotencyStats() {
  const store = await getStore();
  return {
    backend: store.backend,
    durableSize: await store.size(),
    hotCacheSize: hot.size,
    ttlMs: ttlMs(),
  };
}

// ── Recent-events log (in-memory ring, for /debug/webhooks) ─────────────────
export type WebhookOutcome = "accepted" | "duplicate" | "rejected";
export type RecentEvent = {
  at: number;               // epoch ms
  outcome: WebhookOutcome;
  eventId: string | null;
  eventType: string | null;
  reason?: string;          // present when rejected
  backend?: "redis" | "file";
};

const recent: RecentEvent[] =
  (globalThis as any).__plutoWebhookRecent ?? [];
(globalThis as any).__plutoWebhookRecent = recent;

export function logOutcome(ev: Omit<RecentEvent, "at"> & { at?: number }) {
  recent.unshift({ at: ev.at ?? Date.now(), ...ev });
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
}

export function listRecent(limit = 50): RecentEvent[] {
  const ttl = ttlMs();
  const now = Date.now();
  return recent.slice(0, limit).map((e) => {
    // Return an enriched copy; the outcome's TTL only applies to seen-ids.
    const expiresAt = e.eventId && e.outcome !== "rejected" ? e.at + ttl : null;
    const ttlRemaining = expiresAt ? Math.max(0, expiresAt - now) : null;
    return { ...e, expiresAt, ttlRemaining } as RecentEvent & {
      expiresAt: number | null;
      ttlRemaining: number | null;
    };
  });
}

export function resetRecent() {
  recent.length = 0;
}
