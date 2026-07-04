// Phase 53 — Per-function KV store (in-memory shim; a real deployment would
// back this with a durable KV like Cloudflare KV or DynamoDB).
// Keys are namespaced by `${workspace}/${module}` so functions are isolated.
type Entry = { value: string; expiresAt: number | null };
const store = new Map<string, Map<string, Entry>>();

function ns(workspace: string, module: string): Map<string, Entry> {
  const k = `${workspace}/${module}`;
  let m = store.get(k);
  if (!m) { m = new Map(); store.set(k, m); }
  return m;
}

export function kvPut(workspace: string, module: string, key: string, value: string, ttl_ms?: number): void {
  ns(workspace, module).set(key, { value, expiresAt: ttl_ms ? Date.now() + ttl_ms : null });
}

export function kvGet(workspace: string, module: string, key: string): string | null {
  const e = ns(workspace, module).get(key);
  if (!e) return null;
  if (e.expiresAt && e.expiresAt < Date.now()) { ns(workspace, module).delete(key); return null; }
  return e.value;
}

export function kvDelete(workspace: string, module: string, key: string): boolean {
  return ns(workspace, module).delete(key);
}

export function kvList(workspace: string, module: string, prefix = ""): Array<{ key: string; expires_at: number | null }> {
  const m = ns(workspace, module);
  const now = Date.now();
  const out: Array<{ key: string; expires_at: number | null }> = [];
  for (const [k, v] of m) {
    if (v.expiresAt && v.expiresAt < now) { m.delete(k); continue; }
    if (k.startsWith(prefix)) out.push({ key: k, expires_at: v.expiresAt });
  }
  return out;
}

export function kvClear(): void { store.clear(); }
