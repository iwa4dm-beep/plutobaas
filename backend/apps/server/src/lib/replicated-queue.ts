// Phase 56 — Replicated queue.
// Extends the in-process queue with multi-region replication: every publish
// fans out to registered peer transports, and duplicate deliveries are
// suppressed by (queue, message_id). Retries use exponential backoff with a
// dead-letter tier after `max_attempts`.

export type QueueMessage = {
  id: string;
  queue: string;
  body: unknown;
  attempts: number;
  next_attempt_at: number;
  region: string;
  enqueued_at: number;
};

export type PeerPublish = (msg: QueueMessage) => void | Promise<void>;
export type DeliverResult = { ok: boolean; error?: string };
export type Dispatcher = (msg: QueueMessage) => Promise<DeliverResult>;

const queues = new Map<string, QueueMessage[]>();
const dlq = new Map<string, QueueMessage[]>();
const seen = new Map<string, Set<string>>(); // per-queue dedupe cache
const peers: PeerPublish[] = [];
let localRegion = "local";
let seq = 0;

const BACKOFF = [50, 200, 1_000, 5_000, 30_000];
const MAX_ATTEMPTS = 5;
const DEDUPE_CAP = 10_000;

export function configureReplicated(region: string, transports: PeerPublish[] = []): void {
  localRegion = region;
  peers.splice(0, peers.length, ...transports);
}

function seenSet(queue: string): Set<string> {
  let s = seen.get(queue);
  if (!s) { s = new Set(); seen.set(queue, s); }
  return s;
}

export async function publish(queue: string, body: unknown, opts: { id?: string } = {}): Promise<QueueMessage> {
  const id = opts.id ?? `m_${localRegion}_${++seq}_${Date.now()}`;
  const dedupe = seenSet(queue);
  if (dedupe.has(id)) {
    // Duplicate — return the existing message if we still have it.
    const existing = (queues.get(queue) ?? []).find((m) => m.id === id);
    if (existing) return existing;
  }
  dedupe.add(id);
  if (dedupe.size > DEDUPE_CAP) { const first = dedupe.values().next().value; if (first) dedupe.delete(first); }
  const msg: QueueMessage = { id, queue, body, attempts: 0, next_attempt_at: Date.now(),
    region: localRegion, enqueued_at: Date.now() };
  const list = queues.get(queue) ?? [];
  list.push(msg);
  queues.set(queue, list);
  await Promise.all(peers.map((p) => Promise.resolve(p(msg))));
  return msg;
}

/** Peer receiver — called from a replication endpoint. Idempotent. */
export function applyRemote(msg: QueueMessage): { accepted: boolean } {
  const dedupe = seenSet(msg.queue);
  if (dedupe.has(msg.id)) return { accepted: false };
  dedupe.add(msg.id);
  const list = queues.get(msg.queue) ?? [];
  list.push({ ...msg }); // clone so local mutation doesn't leak
  queues.set(msg.queue, list);
  return { accepted: true };
}

export async function poll(queue: string, dispatch: Dispatcher, max = 50): Promise<{ processed: number; failed: number; dead: number }> {
  const list = queues.get(queue) ?? [];
  let processed = 0, failed = 0, dead = 0;
  const now = Date.now();
  const remaining: QueueMessage[] = [];
  let taken = 0;
  for (const m of list) {
    if (taken >= max || m.next_attempt_at > now) { remaining.push(m); continue; }
    taken++;
    m.attempts++;
    const r = await dispatch(m);
    if (r.ok) { processed++; continue; }
    if (m.attempts >= MAX_ATTEMPTS) {
      const d = dlq.get(queue) ?? []; d.push({ ...m, next_attempt_at: Date.now() }); dlq.set(queue, d);
      dead++;
      continue;
    }
    const wait = BACKOFF[Math.min(m.attempts - 1, BACKOFF.length - 1)]!;
    m.next_attempt_at = Date.now() + wait;
    remaining.push(m);
    failed++;
  }
  queues.set(queue, remaining);
  return { processed, failed, dead };
}

export function pendingMessages(queue: string): number { return (queues.get(queue) ?? []).length; }
export function deadLetter(queue: string): QueueMessage[] { return [...(dlq.get(queue) ?? [])]; }
export function clearReplicated(): void { queues.clear(); dlq.clear(); seen.clear(); peers.splice(0, peers.length); localRegion = "local"; seq = 0; }
