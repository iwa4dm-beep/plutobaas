// Per-(channel, subscriber) offline queue with monotonic seq and TTL.
//
// Backed by an in-memory map; production wiring can swap this for
// rt4_offline_queue rows without changing callers. The queue guarantees:
//   * enqueue order is preserved (insertion order)
//   * drain returns items with strictly increasing `seq`
//   * ack(upto_seq) removes acknowledged prefixes
//   * expired items are pruned on every access

export type QueueItem = {
  seq: number;
  event: string;
  payload: unknown;
  is_delta: boolean;
  base_hash: string | null;
  enqueued_at: number;
  expires_at: number;
};

type Key = string;
const store = new Map<Key, QueueItem[]>();
const seqByChan = new Map<string, number>();

const k = (channel: string, subscriber: string): Key => `${channel}::${subscriber}`;

function pruneExpired(list: QueueItem[]): QueueItem[] {
  const now = Date.now();
  return list.filter((x) => x.expires_at > now);
}

export function enqueue(input: {
  channel: string; subscriber: string; event: string; payload: unknown;
  is_delta?: boolean; base_hash?: string | null; ttl_ms?: number;
}): QueueItem {
  const now = Date.now();
  const nextSeq = (seqByChan.get(input.channel) ?? 0) + 1;
  seqByChan.set(input.channel, nextSeq);
  const item: QueueItem = {
    seq: nextSeq,
    event: input.event,
    payload: input.payload,
    is_delta: input.is_delta ?? false,
    base_hash: input.base_hash ?? null,
    enqueued_at: now,
    expires_at: now + (input.ttl_ms ?? 60_000),
  };
  const key = k(input.channel, input.subscriber);
  const list = pruneExpired(store.get(key) ?? []);
  list.push(item);
  store.set(key, list);
  return item;
}

export function drain(channel: string, subscriber: string, since_seq = 0): QueueItem[] {
  const key = k(channel, subscriber);
  const list = pruneExpired(store.get(key) ?? []);
  store.set(key, list);
  return list.filter((x) => x.seq > since_seq).sort((a, b) => a.seq - b.seq);
}

export function ack(channel: string, subscriber: string, upto_seq: number): number {
  const key = k(channel, subscriber);
  const list = pruneExpired(store.get(key) ?? []);
  const kept = list.filter((x) => x.seq > upto_seq);
  store.set(key, kept);
  return list.length - kept.length;
}

export function size(channel: string, subscriber: string): number {
  return pruneExpired(store.get(k(channel, subscriber)) ?? []).length;
}

export function _reset(): void { store.clear(); seqByChan.clear(); }
