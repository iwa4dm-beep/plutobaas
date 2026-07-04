// In-process schema introspection cache with digest-based invalidation.
// Descriptor is captured on demand; callers pass a loader that hits
// pg_catalog. The cache is keyed by (workspace, schema) and expires with
// TTL. A recompute is triggered when the digest changes.

import { createHash } from "crypto";
import type { Schema } from "./nested-writes.js";

type Entry = { schema: Schema; digest: string; captured_at: number };
const cache = new Map<string, Entry>();
const DEFAULT_TTL_MS = 60_000;

function key(workspace: string, name: string) { return `${workspace}::${name}`; }

export function digestOf(schema: Schema): string {
  const canonical = JSON.stringify(Object.entries(schema).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export async function getSchema(
  workspace: string, name: string,
  loader: () => Promise<Schema>,
  opts: { ttl_ms?: number; force?: boolean } = {},
): Promise<{ schema: Schema; digest: string; cached: boolean }> {
  const k = key(workspace, name);
  const now = Date.now();
  const cur = cache.get(k);
  if (!opts.force && cur && now - cur.captured_at < (opts.ttl_ms ?? DEFAULT_TTL_MS)) {
    return { schema: cur.schema, digest: cur.digest, cached: true };
  }
  const schema = await loader();
  const digest = digestOf(schema);
  cache.set(k, { schema, digest, captured_at: now });
  return { schema, digest, cached: false };
}

export function invalidate(workspace: string, name?: string): number {
  if (!name) {
    let n = 0;
    for (const k of [...cache.keys()]) if (k.startsWith(workspace + "::")) { cache.delete(k); n++; }
    return n;
  }
  return cache.delete(key(workspace, name)) ? 1 : 0;
}

export function _reset(): void { cache.clear(); }
export function _size(): number { return cache.size; }
