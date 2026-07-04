// Phase 51 — end-to-end tests for presence CRDT convergence,
// offline queue replay ordering, and delta encode/decode round-trip.

import { describe, it, expect, beforeEach } from "vitest";
import { createHlc } from "../lib/hlc.js";
import { apply, merge, members, empty, type PresenceEntry } from "../lib/presence-crdt.js";
import { encodeDelta, decodeDelta } from "../lib/delta-codec.js";
import { enqueue, drain, ack, _reset } from "../lib/offline-queue.js";

function entry(actor: string, hlc: { ts: number; ctr: number; actor: string }, meta: Record<string, unknown> = {}, tombstone = false): PresenceEntry {
  return { actor, hlc, metadata: meta, tombstone };
}

describe("presence CRDT convergence", () => {
  it("merges commutatively regardless of order", () => {
    const A = empty(), B = empty();
    const h1 = { ts: 1000, ctr: 0, actor: "a" };
    const h2 = { ts: 1000, ctr: 1, actor: "b" };
    const h3 = { ts: 1001, ctr: 0, actor: "a" };
    apply(A, entry("u1", h1, { role: "editor" }));
    apply(A, entry("u1", h3, { role: "admin" }));
    apply(B, entry("u1", h2, { role: "viewer" }));

    const AB = merge(A, B);
    const BA = merge(B, A);
    expect(members(AB)).toEqual(members(BA));
    expect(members(AB)[0].metadata.role).toBe("admin"); // h3 is latest
  });

  it("respects tombstones under LWW", () => {
    const S = empty();
    apply(S, entry("u1", { ts: 5, ctr: 0, actor: "a" }, { x: 1 }));
    apply(S, entry("u1", { ts: 6, ctr: 0, actor: "a" }, {}, true));
    expect(members(S)).toHaveLength(0);
  });

  it("HLC preserves causal ordering across observe()", () => {
    const clockA = createHlc("a", () => 1000);
    const clockB = createHlc("b", () => 999);
    const t1 = clockA.now();
    const t2 = clockB.observe(t1);
    expect(t2.ts).toBeGreaterThanOrEqual(t1.ts);
    expect(t2.ctr).toBeGreaterThan(0);
  });
});

describe("offline queue replay ordering", () => {
  beforeEach(() => _reset());

  it("preserves monotonic seq and filters by since_seq", () => {
    enqueue({ channel: "c1", subscriber: "s", event: "e", payload: { i: 1 } });
    enqueue({ channel: "c1", subscriber: "s", event: "e", payload: { i: 2 } });
    enqueue({ channel: "c1", subscriber: "s", event: "e", payload: { i: 3 } });
    const all = drain("c1", "s", 0);
    expect(all.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(drain("c1", "s", 1).map((x) => (x.payload as { i: number }).i)).toEqual([2, 3]);
  });

  it("ack removes acknowledged prefix", () => {
    enqueue({ channel: "c2", subscriber: "s", event: "e", payload: 1 });
    enqueue({ channel: "c2", subscriber: "s", event: "e", payload: 2 });
    const removed = ack("c2", "s", 1);
    expect(removed).toBe(1);
    expect(drain("c2", "s", 0).map((x) => x.seq)).toEqual([2]);
  });

  it("expires TTL entries on drain", async () => {
    enqueue({ channel: "c3", subscriber: "s", event: "e", payload: 1, ttl_ms: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(drain("c3", "s", 0)).toHaveLength(0);
  });
});

describe("delta codec round-trip", () => {
  it("encodes changed keys and decodes back to full payload", () => {
    const base = { title: "hello", n: 1, tag: "x" };
    const next = { title: "hello", n: 2, extra: true };
    const env = encodeDelta(base, next);
    expect(env.full).toBeUndefined();
    expect(env.ops?.length).toBeGreaterThan(0);
    const decoded = decodeDelta(base, env);
    expect(decoded).toEqual(next);
  });

  it("falls back to full payload when no baseline", () => {
    const env = encodeDelta(null, { a: 1 });
    expect(env.full).toEqual({ a: 1 });
    expect(decodeDelta(null, env)).toEqual({ a: 1 });
  });

  it("reduces bytes for small mutations on large payloads", () => {
    const bigItems = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * 3 }));
    const base = { items: bigItems, meta: { author: "user-alpha", ts: 1 } };
    const next = { items: bigItems, meta: { author: "user-alpha", ts: 2 } };
    const env = encodeDelta(base, next);
    expect(JSON.stringify(env).length).toBeLessThan(JSON.stringify(next).length);
  });
});
