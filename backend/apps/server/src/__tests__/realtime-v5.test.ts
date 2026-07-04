// Phase 60 unit tests — presence sharding, ordered delivery, backpressure.
import { describe, it, expect, beforeEach } from "vitest";
import * as ps from "../lib/presence-shard.js";
import * as od from "../lib/ordered-delivery.js";
import * as bp from "../lib/room-backpressure.js";

beforeEach(() => { ps._resetPresenceForTests(); od._resetOrderedForTests(); bp._resetBackpressureForTests(); });

describe("presence sharding", () => {
  it("routes the same (workspace,user) to the same shard deterministically", () => {
    const a = ps.whichShard("w1", "u42");
    const b = ps.whichShard("w1", "u42");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(ps.shardCount());
  });

  it("distributes many users across multiple shards", () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 500; i++) buckets.add(ps.whichShard("w1", `u${i}`));
    expect(buckets.size).toBeGreaterThan(1);
  });

  it("upsert and list return the same member", () => {
    ps.upsertPresence({ workspace: "w1", room: "r1", user_id: "u1", status: "online" });
    const list = ps.listRoom("w1", "r1");
    expect(list).toHaveLength(1);
    expect(list[0].user_id).toBe("u1");
  });

  it("remove clears the shard entry", () => {
    ps.upsertPresence({ workspace: "w1", room: "r1", user_id: "u1", status: "online" });
    expect(ps.removePresence("w1", "r1", "u1")).toBe(true);
    expect(ps.listRoom("w1", "r1")).toHaveLength(0);
  });
});

describe("ordered delivery", () => {
  const mk = (room: string, seq: number, id = `x${seq}`) => ({ room, seq, id, payload: seq, ts: Date.now() });

  it("delivers in-order messages immediately", () => {
    const r1 = od.ingest(mk("r", 1));
    expect(r1.deliver.map((m) => m.seq)).toEqual([1]);
    const r2 = od.ingest(mk("r", 2));
    expect(r2.deliver.map((m) => m.seq)).toEqual([2]);
  });

  it("buffers out-of-order arrivals and drains once the gap is filled", () => {
    const a = od.ingest(mk("r", 2));
    expect(a.deliver).toHaveLength(0);
    const b = od.ingest(mk("r", 3));
    expect(b.deliver).toHaveLength(0);
    const c = od.ingest(mk("r", 1));
    expect(c.deliver.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("drops duplicate ids and old seqs", () => {
    od.ingest(mk("r", 1, "same"));
    const dup = od.ingest(mk("r", 1, "same"));
    expect(dup.dropped).toBe("duplicate");
  });
});

describe("room backpressure", () => {
  it("drop_oldest evicts the head when the queue is full", () => {
    bp.subscribe("s1", "r", { policy: "drop_oldest", max_queue: 3 });
    for (let i = 0; i < 5; i++) bp.push("r", i);
    const out = bp.drain("s1");
    expect(out).toEqual([2, 3, 4]);
    expect(bp.stats("s1")?.dropped).toBe(2);
  });

  it("drop_newest keeps the head and rejects new messages", () => {
    bp.subscribe("s1", "r", { policy: "drop_newest", max_queue: 3 });
    for (let i = 0; i < 5; i++) bp.push("r", i);
    expect(bp.drain("s1")).toEqual([0, 1, 2]);
  });

  it("pause policy marks subscriber paused and stops delivery until resume", () => {
    bp.subscribe("s1", "r", { policy: "pause", max_queue: 2 });
    bp.push("r", "a"); bp.push("r", "b"); bp.push("r", "c");
    expect(bp.stats("s1")?.paused).toBe(true);
    bp.push("r", "d");
    expect(bp.drain("s1")).toEqual(["a", "b"]);
    bp.resume("s1");
    bp.push("r", "e");
    expect(bp.drain("s1")).toEqual(["e"]);
  });
});
