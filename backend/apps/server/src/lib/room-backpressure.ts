// Phase 60 — Room-level backpressure.
//
// Each subscriber gets a bounded outbound queue. On overflow we apply a
// per-room policy: `drop_oldest` (default), `drop_newest`, or `pause`
// (mark subscriber paused, stop pushing until it resumes). Metrics are
// exposed for observability.

export type BackpressurePolicy = "drop_oldest" | "drop_newest" | "pause";

export type Subscriber = {
  id: string;
  room: string;
  queue: unknown[];
  paused: boolean;
  dropped: number;
  policy: BackpressurePolicy;
  max_queue: number;
};

const subs = new Map<string, Subscriber>();

export function subscribe(
  id: string, room: string,
  opts: { policy?: BackpressurePolicy; max_queue?: number } = {},
): Subscriber {
  const s: Subscriber = {
    id, room,
    queue: [], paused: false, dropped: 0,
    policy: opts.policy ?? "drop_oldest",
    max_queue: opts.max_queue ?? 100,
  };
  subs.set(id, s);
  return s;
}

export function unsubscribe(id: string) { subs.delete(id); }

export function push(room: string, msg: unknown): { delivered: number; dropped: number; paused: number } {
  let delivered = 0, dropped = 0, paused = 0;
  for (const s of subs.values()) {
    if (s.room !== room) continue;
    if (s.paused) { paused++; continue; }
    if (s.queue.length >= s.max_queue) {
      if (s.policy === "drop_oldest") { s.queue.shift(); s.queue.push(msg); s.dropped++; dropped++; }
      else if (s.policy === "drop_newest") { s.dropped++; dropped++; }
      else { s.paused = true; paused++; }
      continue;
    }
    s.queue.push(msg); delivered++;
  }
  return { delivered, dropped, paused };
}

export function drain(id: string, n = Infinity): unknown[] {
  const s = subs.get(id); if (!s) return [];
  const out = s.queue.splice(0, n);
  return out;
}

export function resume(id: string): boolean {
  const s = subs.get(id); if (!s) return false;
  s.paused = false; return true;
}

export function stats(id: string) {
  const s = subs.get(id); if (!s) return null;
  return { id: s.id, room: s.room, queued: s.queue.length, paused: s.paused, dropped: s.dropped, policy: s.policy, max_queue: s.max_queue };
}

export function _resetBackpressureForTests() { subs.clear(); }
