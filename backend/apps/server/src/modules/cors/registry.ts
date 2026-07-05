// Phase 63 — in-memory cache of CORS allow-list rows, refreshed from
// public.allowed_origins. The dynamic Fastify CORS origin() callback
// consults this cache on every preflight/request (O(1) Set lookup).

import { db } from "../../db/index.js";

type Row = { workspace_id: string | null; origin: string };

const cache = { origins: new Set<string>(), loadedAt: 0 };
const TTL_MS = 15_000;

export async function refreshAllowedOrigins(): Promise<Set<string>> {
  try {
    const rows = (await db
      .selectFrom("allowed_origins" as never)
      .select(["workspace_id", "origin"] as never)
      .execute()) as unknown as Row[];
    cache.origins = new Set(rows.map((r) => r.origin.trim().toLowerCase()));
    cache.loadedAt = Date.now();
  } catch {
    // Table may not exist yet (pre-migration). Fall back to empty allow-list.
    cache.origins = new Set();
    cache.loadedAt = Date.now();
  }
  return cache.origins;
}

export async function isOriginAllowed(origin: string): Promise<boolean> {
  if (Date.now() - cache.loadedAt > TTL_MS) await refreshAllowedOrigins();
  return cache.origins.has(origin.trim().toLowerCase());
}

export function invalidateOriginCache(): void {
  cache.loadedAt = 0;
}
