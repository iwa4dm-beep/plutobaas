// Phase 53 — Edge v5 KV + queue tests.
import { describe, it, expect, beforeEach } from "vitest";
import { kvPut, kvGet, kvDelete, kvList, kvClear } from "../lib/edge-kv.js";
import { bind, enqueue, drain, pending, clearQueues } from "../lib/edge-queue.js";

beforeEach(() => { kvClear(); clearQueues(); });

describe("edge-kv", () => {
  it("isolates per-module namespaces", () => {
    kvPut("w1", "modA", "k", "a");
    kvPut("w1", "modB", "k", "b");
    expect(kvGet("w1", "modA", "k")).toBe("a");
    expect(kvGet("w1", "modB", "k")).toBe("b");
  });
  it("respects TTL", async () => {
    kvPut("w1", "m", "k", "v", 5);
    await new Promise((r) => setTimeout(r, 15));
    expect(kvGet("w1", "m", "k")).toBeNull();
  });
  it("lists by prefix and deletes", () => {
    kvPut("w1", "m", "user:1", "a");
    kvPut("w1", "m", "user:2", "b");
    kvPut("w1", "m", "other", "c");
    expect(kvList("w1", "m", "user:")).toHaveLength(2);
    expect(kvDelete("w1", "m", "user:1")).toBe(true);
    expect(kvList("w1", "m", "user:")).toHaveLength(1);
  });
});

describe("edge-queue", () => {
  it("dispatches to bound subscribers and clears queue on success", async () => {
    bind("q1", { module: "worker", version: 1 });
    enqueue("q1", { hello: "world" });
    enqueue("q1", { a: 1 });
    expect(pending("q1")).toBe(2);
    const seen: unknown[] = [];
    const r = await drain("q1", async (_s, j) => { seen.push(j.body); return { ok: true }; });
    expect(r.processed).toBe(2);
    expect(pending("q1")).toBe(0);
    expect(seen).toHaveLength(2);
  });
  it("re-queues on failure", async () => {
    bind("q2", { module: "w", version: 1 });
    enqueue("q2", {});
    const r = await drain("q2", async () => ({ ok: false, error: "boom" }));
    expect(r.failed).toBe(1);
    expect(pending("q2")).toBe(1);
  });
});
