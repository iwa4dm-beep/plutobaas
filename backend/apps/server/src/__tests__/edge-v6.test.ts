// Phase 55 — Edge v6 unit tests: host-fetch, durable objects, KV backplane.
import { describe, it, expect, beforeEach } from "vitest";
import { hostFetch, setAllowlist, isAllowed, clearAllowlists } from "../lib/host-fetch.js";
import { callDo, getState, clearDo, registerClass } from "../lib/durable-objects.js";
import { bpPut, bpGet, bpDelete, bpApplyRemote, bpKeys, bpClear, configureBackplane } from "../lib/kv-backplane.js";

beforeEach(() => { clearAllowlists(); clearDo(); bpClear(); });

describe("host-fetch", () => {
  it("blocks non-https and non-allowlisted hosts", async () => {
    setAllowlist("w1", ["api.example.com"]);
    await expect(hostFetch("w1", { url: "http://api.example.com" })).rejects.toThrow(/scheme_forbidden/);
    await expect(hostFetch("w1", { url: "https://evil.com" })).rejects.toThrow(/host_not_allowed/);
    expect(isAllowed("w1", "api.example.com")).toBe(true);
    expect(isAllowed("w1", "sub.api.example.com")).toBe(true);
    expect(isAllowed("w1", "example.com")).toBe(false);
  });
  it("passes through via injected fetch and returns base64 body", async () => {
    setAllowlist("w1", ["api.example.com"]);
    const fakeFetch = (async () => new Response("hello", { status: 200, headers: { "x-a": "b" } })) as unknown as typeof fetch;
    const r = await hostFetch("w1", { url: "https://api.example.com/x" }, fakeFetch);
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body_base64, "base64").toString()).toBe("hello");
    expect(r.headers["x-a"]).toBe("b");
  });
});

describe("durable-objects", () => {
  it("serializes concurrent calls to the same id", async () => {
    const promises = Array.from({ length: 20 }, () => callDo("counter", "room-1", { method: "inc" }));
    const results = await Promise.all(promises);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((getState("counter", "room-1") as { value: number }).value).toBe(20);
  });
  it("isolates different ids", async () => {
    await callDo("counter", "a", { method: "inc" });
    await callDo("counter", "b", { method: "inc", args: { by: 5 } });
    expect((getState("counter", "a") as { value: number }).value).toBe(1);
    expect((getState("counter", "b") as { value: number }).value).toBe(5);
  });
  it("returns error for unknown class or method", async () => {
    const r1 = await callDo("nope", "x", { method: "get" });
    expect(r1.ok).toBe(false);
    registerClass("noop", (s) => ({ state: s }));
    const r2 = await callDo("noop", "x", { method: "any" });
    expect(r2.ok).toBe(true);
  });
});

describe("kv-backplane", () => {
  it("increments version on every put and fans out to peers", async () => {
    const seen: unknown[] = [];
    configureBackplane("us-east", [(op) => { seen.push(op); }]);
    const e1 = await bpPut("app", "k", "a");
    const e2 = await bpPut("app", "k", "b");
    expect(e1.version).toBe(1);
    expect(e2.version).toBe(2);
    expect(seen).toHaveLength(2);
  });
  it("LWW: higher version wins; region breaks ties", () => {
    bpApplyRemote({ kind: "put", ns: "n", key: "k",
      entry: { value: "old", version: 3, updated_at: 1, region: "us-east" } });
    // Same version, lexically-smaller region wins
    bpApplyRemote({ kind: "put", ns: "n", key: "k",
      entry: { value: "new", version: 3, updated_at: 2, region: "eu-west" } });
    expect(bpGet("n", "k")?.value).toBe("new");
    // Higher version wins regardless of region
    bpApplyRemote({ kind: "put", ns: "n", key: "k",
      entry: { value: "top", version: 4, updated_at: 3, region: "us-east" } });
    expect(bpGet("n", "k")?.value).toBe("top");
    // Lower version ignored
    const before = bpGet("n", "k")?.value;
    bpApplyRemote({ kind: "put", ns: "n", key: "k",
      entry: { value: "loser", version: 2, updated_at: 4, region: "eu-west" } });
    expect(bpGet("n", "k")?.value).toBe(before);
  });
  it("keys() filters by prefix and delete removes entries", async () => {
    await bpPut("n", "u:1", "a"); await bpPut("n", "u:2", "b"); await bpPut("n", "z", "c");
    expect(bpKeys("n", "u:").sort()).toEqual(["u:1", "u:2"]);
    await bpDelete("n", "u:1");
    expect(bpKeys("n", "u:")).toEqual(["u:2"]);
  });
});
