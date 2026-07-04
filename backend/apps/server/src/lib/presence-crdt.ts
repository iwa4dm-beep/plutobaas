// Presence CRDT — LWW-Element-Set keyed by HLC.
//
// Each actor (member) emits `set` or `remove` mutations tagged with a
// Hybrid-Logical-Clock stamp. Merging two states is commutative,
// associative, and idempotent — any replica that has seen the same set
// of ops converges to the same view, regardless of arrival order.

import { compareHlc, type Hlc } from "./hlc.js";

export type PresenceEntry = {
  actor: string;
  hlc: Hlc;
  metadata: Record<string, unknown>;
  tombstone: boolean;
};

export type PresenceState = Map<string, PresenceEntry>;

export function empty(): PresenceState { return new Map(); }

/** Apply one mutation. Returns whether local state changed. */
export function apply(state: PresenceState, next: PresenceEntry): boolean {
  const cur = state.get(next.actor);
  if (cur && compareHlc(next.hlc, cur.hlc) <= 0) return false;
  state.set(next.actor, next);
  return true;
}

/** Merge two states element-wise. Deterministic and idempotent. */
export function merge(a: PresenceState, b: PresenceState): PresenceState {
  const out: PresenceState = new Map(a);
  for (const [k, v] of b) apply(out, v);
  return out;
}

/** Live members (tombstones filtered) for outward emission. */
export function members(state: PresenceState): PresenceEntry[] {
  return [...state.values()]
    .filter((e) => !e.tombstone)
    .sort((x, y) => (x.actor < y.actor ? -1 : x.actor > y.actor ? 1 : 0));
}

/** Compute join/leave delta relative to a prior snapshot. */
export function diff(prev: PresenceState, next: PresenceState): { joined: string[]; left: string[] } {
  const p = new Set(members(prev).map((e) => e.actor));
  const n = new Set(members(next).map((e) => e.actor));
  const joined: string[] = []; const left: string[] = [];
  for (const a of n) if (!p.has(a)) joined.push(a);
  for (const a of p) if (!n.has(a)) left.push(a);
  return { joined: joined.sort(), left: left.sort() };
}
