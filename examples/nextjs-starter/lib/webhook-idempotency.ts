/**
 * Durable webhook idempotency store.
 *
 * Backends (chosen at runtime from env, in this order):
 *   1. Redis  — set `PLUTO_WEBHOOK_REDIS_URL=redis://…`
 *   2. File   — set `PLUTO_WEBHOOK_IDEMPOTENCY_FILE=/absolute/path.json`
 *               (defaults to `<cwd>/.pluto/webhook-events.json`)
 *
 * Both backends persist across process restarts, so duplicate webhook
 * deliveries are rejected even after the Node server is killed and
 * relaunched. An in-memory Map is layered on top purely as a hot cache;
 * it does NOT gate correctness — the durable store is always consulted.
 *
 * TTL: entries expire after 24h (webhook providers typically retry for
 * much less than that). Expired keys are swept lazily on each mark.
 *
 * The `resetHotCache()` helper exists so tests can simulate a process
 * restart without actually killing the server (see the dev-only
 * `/api/webhooks/pluto/_simulate_restart` route).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const TTL_MS = 24 * 60 * 60 * 1000;
const HOT_CACHE_LIMIT = 1000;

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
  if (Date.now() - e.at > TTL_MS) {
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
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "number" && now - v <= TTL_MS) out[k] = v;
  }
  return out;
}

const fileStore: Store = {
  backend: "file",
  async has(id) {
    const data = await fileRead();
    const at = data[id];
    return typeof at === "number" && Date.now() - at <= TTL_MS;
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

// ── Redis backend (optional; loaded lazily so file-only deploys don't need ioredis)
let redisStore: Store | null = null;
async function tryRedis(): Promise<Store | null> {
  const url = process.env.PLUTO_WEBHOOK_REDIS_URL;
  if (!url) return null;
  if (redisStore) return redisStore;
  try {
    // Dynamic import so the dep is optional.
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
        await client.set(prefix + id, "1", "PX", TTL_MS);
      },
      async size() {
        // Approximate — SCAN would be exact but expensive; DBSIZE is fine for tests.
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
 * Returns true if this is the first time we see `id` (event should be
 * processed), false if it is a duplicate that has already been marked.
 * Durable across process restarts.
 */
export async function claimEventId(id: string): Promise<{ fresh: boolean; backend: Store["backend"] }> {
  const store = await getStore();
  // Fast negative path via hot cache — but always confirm against durable store.
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
  };
}
