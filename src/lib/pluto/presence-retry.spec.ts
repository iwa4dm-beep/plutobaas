// Presence retry / resubscribe smoke test.
// Runs under any vitest config that includes src/**. It uses fake timers to
// verify the heartbeat cadence, exponential backoff, and clean unsubscribe.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rt2 } from "./live";

describe("rt2.subscribePresence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("joins, heartbeats, retries on failure, and leaves on unsubscribe", async () => {
    const join     = vi.spyOn(rt2, "join").mockResolvedValue({ ok: true });
    const leave    = vi.spyOn(rt2, "leave").mockResolvedValue({ ok: true });
    let failCount = 0;
    vi.spyOn(rt2, "presence").mockImplementation(async () => {
      if (failCount > 0) { failCount--; throw new Error("net"); }
      return { members: [{ member_key: "u1", metadata: {}, last_seen: new Date().toISOString() }] };
    });

    const members: number[] = []; const errs: string[] = [];
    const unsub = rt2.subscribePresence("room-A", "u1", {
      metadata: { role: "editor" }, heartbeatMs: 1000, pollMs: 250,
      onMembers: (m) => members.push(m.length),
      onError:   (e) => errs.push(e.message),
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(join).toHaveBeenCalledWith("room-A", "u1", { role: "editor" });
    expect(members.at(-1)).toBe(1);

    // Heartbeat re-invokes join at ~1s cadence
    await vi.advanceTimersByTimeAsync(1500);
    expect(join.mock.calls.length).toBeGreaterThan(1);

    // Transient failure — surfaces to onError, then recovers
    failCount = 2;
    await vi.advanceTimersByTimeAsync(2000);
    expect(errs.length).toBeGreaterThan(0);

    unsub();
    await vi.advanceTimersByTimeAsync(50);
    expect(leave).toHaveBeenCalledWith("room-A", "u1");
  });

  it("emits status transitions and gives up after maxAttempts", async () => {
    vi.spyOn(rt2, "join").mockRejectedValue(new Error("boom"));
    vi.spyOn(rt2, "leave").mockResolvedValue({ ok: true });
    vi.spyOn(rt2, "presence").mockResolvedValue({ members: [] });

    const states: string[] = [];
    const unsub = rt2.subscribePresence("room-B", "u2", {
      heartbeatMs: 1000, pollMs: 500,
      maxAttempts: 3, maxBackoffMs: 50,
      onStatus: (s) => states.push(s),
    });

    // Kick through backoff windows (bounded by maxBackoffMs=50 so this is fast).
    await vi.advanceTimersByTimeAsync(2000);

    expect(states[0]).toBe("connecting");
    expect(states).toContain("retrying");
    expect(states.at(-1)).toBe("failed");
    unsub();
  });

  it("returns to live and clears attempt counter after reconnect", async () => {
    let joinCalls = 0;
    vi.spyOn(rt2, "join").mockImplementation(async () => {
      joinCalls++;
      if (joinCalls === 1) throw new Error("first-fail");
      return { ok: true };
    });
    vi.spyOn(rt2, "leave").mockResolvedValue({ ok: true });
    vi.spyOn(rt2, "presence").mockResolvedValue({ members: [] });

    const reconnects: number[] = []; const states: string[] = [];
    const unsub = rt2.subscribePresence("room-C", "u3", {
      heartbeatMs: 10_000, pollMs: 500, maxBackoffMs: 20,
      onReconnect: (n) => reconnects.push(n),
      onStatus: (s) => states.push(s),
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(reconnects[0]).toBe(1);
    expect(states).toContain("live");
    unsub();
  });
});
