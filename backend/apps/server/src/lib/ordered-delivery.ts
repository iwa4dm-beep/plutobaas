// Phase 60 — Ordered room delivery + de-duplication.
//
// Each room has a monotonically increasing `seq`. Publishers stamp
// messages and consumers reorder gaps up to a bounded window. Duplicate
// seq values are dropped. If a gap exceeds `MAX_HOLD_MS`, the buffer is
// flushed in order and the missing seq is recorded as `skipped_seq` so
// clients can request a replay from persistent storage.

export type RoomMessage = {
  room: string;
  seq: number;
  id: string; // idempotency key
  payload: unknown;
  ts: number;
};

const MAX_HOLD_MS = 500;
const MAX_BUFFER = 256;

type RoomState = {
  next_expected: number;
  buffer: RoomMessage[];
  seen: Set<string>;
  last_flushed_at: number;
  skipped: number[];
};

const rooms = new Map<string, RoomState>();

function stateFor(room: string): RoomState {
  let s = rooms.get(room);
  if (!s) { s = { next_expected: 1, buffer: [], seen: new Set(), last_flushed_at: Date.now(), skipped: [] }; rooms.set(room, s); }
  return s;
}

export function ingest(msg: RoomMessage): { deliver: RoomMessage[]; dropped: "duplicate" | "buffer_full" | null; skipped: number[] } {
  const s = stateFor(msg.room);
  if (s.seen.has(msg.id) || msg.seq < s.next_expected) return { deliver: [], dropped: "duplicate", skipped: [] };
  if (s.buffer.length >= MAX_BUFFER) return { deliver: [], dropped: "buffer_full", skipped: [] };
  s.seen.add(msg.id);
  s.buffer.push(msg);
  s.buffer.sort((a, b) => a.seq - b.seq);

  const deliver: RoomMessage[] = [];
  const skipped: number[] = [];

  // Drain in-order prefix.
  while (s.buffer.length && s.buffer[0].seq === s.next_expected) {
    deliver.push(s.buffer.shift()!);
    s.next_expected++;
  }

  // If the head is not the expected seq but we've held long enough, flush the gap.
  if (s.buffer.length && Date.now() - s.last_flushed_at > MAX_HOLD_MS) {
    while (s.buffer.length && s.buffer[0].seq !== s.next_expected) {
      while (s.next_expected < s.buffer[0].seq) {
        skipped.push(s.next_expected);
        s.next_expected++;
      }
      // Now next_expected == head.seq; drain.
      deliver.push(s.buffer.shift()!);
      s.next_expected++;
    }
  }

  if (deliver.length) s.last_flushed_at = Date.now();
  if (skipped.length) s.skipped.push(...skipped);
  return { deliver, dropped: null, skipped };
}

export function roomStats(room: string) {
  const s = rooms.get(room);
  if (!s) return null;
  return {
    room,
    next_expected: s.next_expected,
    buffered: s.buffer.length,
    seen: s.seen.size,
    skipped: [...s.skipped],
  };
}

export function _resetOrderedForTests() { rooms.clear(); }
