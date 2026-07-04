// Phase 55 — Shared KV backplane.
// Replaces the per-process edge-kv shim with a multi-region-aware store that
// propagates writes to a set of subscribed peers via an injectable transport.
// Real deployments would bind the transport to NATS or Cloudflare KV; the
// in-process shim keeps it deterministic for tests.

export type BackplaneEntry = { value: string; version: number; updated_at: number; region: string };
export type BackplaneOp = { kind: "put" | "del"; ns: string; key: string; entry?: BackplaneEntry };
export type Transport = (op: BackplaneOp) => void | Promise<void>;

const store = new Map<string, Map<string, BackplaneEntry>>();
const peers: Transport[] = [];
let localRegion = "local";

export function configureBackplane(region: string, transports: Transport[] = []): void {
  localRegion = region;
  peers.splice(0, peers.length, ...transports);
}

function ns(n: string): Map<string, BackplaneEntry> {
  let m = store.get(n);
  if (!m) { m = new Map(); store.set(n, m); }
  return m;
}

async function fanout(op: BackplaneOp): Promise<void> {
  await Promise.all(peers.map((p) => Promise.resolve(p(op))));
}

export async function bpPut(nsName: string, key: string, value: string): Promise<BackplaneEntry> {
  const cur = ns(nsName).get(key);
  const entry: BackplaneEntry = { value, version: (cur?.version ?? 0) + 1, updated_at: Date.now(), region: localRegion };
  ns(nsName).set(key, entry);
  await fanout({ kind: "put", ns: nsName, key, entry });
  return entry;
}

export function bpGet(nsName: string, key: string): BackplaneEntry | null {
  return ns(nsName).get(key) ?? null;
}

export async function bpDelete(nsName: string, key: string): Promise<boolean> {
  const had = ns(nsName).delete(key);
  await fanout({ kind: "del", ns: nsName, key });
  return had;
}

/** Apply a remote op — Last-Writer-Wins by (version, region tiebreaker). */
export function bpApplyRemote(op: BackplaneOp): { applied: boolean } {
  const m = ns(op.ns);
  if (op.kind === "del") { m.delete(op.key); return { applied: true }; }
  if (!op.entry) return { applied: false };
  const cur = m.get(op.key);
  if (!cur || op.entry.version > cur.version ||
      (op.entry.version === cur.version && op.entry.region < cur.region)) {
    m.set(op.key, op.entry);
    return { applied: true };
  }
  return { applied: false };
}

export function bpKeys(nsName: string, prefix = ""): string[] {
  return [...ns(nsName).keys()].filter((k) => k.startsWith(prefix));
}

export function bpClear(): void { store.clear(); peers.splice(0, peers.length); localRegion = "local"; }
