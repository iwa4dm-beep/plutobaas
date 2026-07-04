// Phase 48 — In-process broadcast bus with monotonic per-channel sequencing.
//
// Every publish gets a strictly increasing seq per channel so end-to-end tests
// can assert fan-out ordering after reconnects. Messages have a TTL and are
// evicted from the replay buffer once expires_at passes.
//
// Cross-instance fan-out is delegated to the existing NATS backplane. The bus
// itself is per-process; the plugin bridges it to NATS when enabled.

export type BroadcastMessage = {
  seq: number;
  channel: string;
  event: string;
  payload: unknown;
  sender_id: string | null;
  created_at: number;
  expires_at: number;
};

export type Subscriber = (msg: BroadcastMessage) => void;

const REPLAY_CAP = Number(process.env.PLUTO_BROADCAST_REPLAY_CAP ?? 500);

const seqByChannel = new Map<string, number>();
const replayByChannel = new Map<string, BroadcastMessage[]>();
const subsByChannel = new Map<string, Set<Subscriber>>();

function nextSeq(channel: string): number {
  const n = (seqByChannel.get(channel) ?? 0) + 1;
  seqByChannel.set(channel, n);
  return n;
}

function pushReplay(msg: BroadcastMessage) {
  const buf = replayByChannel.get(msg.channel) ?? [];
  buf.push(msg);
  // Drop expired entries and cap size.
  const now = Date.now();
  const kept = buf.filter((m) => m.expires_at > now).slice(-REPLAY_CAP);
  replayByChannel.set(msg.channel, kept);
}

export function publish(input: {
  channel: string;
  event: string;
  payload: unknown;
  sender_id?: string | null;
  ttl_ms?: number;
}): BroadcastMessage {
  const now = Date.now();
  const ttl = input.ttl_ms ?? Number(process.env.PLUTO_BROADCAST_TTL_MS ?? 30_000);
  const msg: BroadcastMessage = {
    seq: nextSeq(input.channel),
    channel: input.channel,
    event: input.event,
    payload: input.payload,
    sender_id: input.sender_id ?? null,
    created_at: now,
    expires_at: now + Math.max(1, ttl),
  };
  pushReplay(msg);
  const subs = subsByChannel.get(input.channel);
  if (subs) for (const s of subs) { try { s(msg); } catch { /* isolate one bad sub */ } }
  return msg;
}

export function subscribe(channel: string, sub: Subscriber): () => void {
  let set = subsByChannel.get(channel);
  if (!set) { set = new Set(); subsByChannel.set(channel, set); }
  set.add(sub);
  return () => { set!.delete(sub); if (set!.size === 0) subsByChannel.delete(channel); };
}

// Reconnect replay — return messages strictly after `since_seq`, ordered.
export function replay(channel: string, since_seq: number): BroadcastMessage[] {
  const buf = replayByChannel.get(channel) ?? [];
  const now = Date.now();
  return buf.filter((m) => m.seq > since_seq && m.expires_at > now);
}

// Deliver a message received from an external backplane. Rewrites seq to the
// local monotonic counter so subscribers still see a well-ordered stream.
export function deliverFromBackplane(m: Omit<BroadcastMessage, "seq">): BroadcastMessage {
  const msg: BroadcastMessage = { ...m, seq: nextSeq(m.channel) };
  pushReplay(msg);
  const subs = subsByChannel.get(msg.channel);
  if (subs) for (const s of subs) { try { s(msg); } catch { /* ignore */ } }
  return msg;
}

export function _resetBroadcastForTests() {
  seqByChannel.clear();
  replayByChannel.clear();
  subsByChannel.clear();
}

export function _stats() {
  return {
    channels: [...seqByChannel.keys()],
    subscribers: [...subsByChannel].reduce((n, [, s]) => n + s.size, 0),
    replay_bytes: [...replayByChannel.values()].reduce((n, b) => n + b.length, 0),
  };
}
