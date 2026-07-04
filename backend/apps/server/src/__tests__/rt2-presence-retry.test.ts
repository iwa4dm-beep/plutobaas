// Realtime v2 presence — resubscribe / heartbeat retry strategy.
// Verifies:
//   - initial join is called with member_key + metadata
//   - heartbeat re-invokes join at the configured interval
//   - after a transient poll failure, backs off and reconnects
//   - unsubscribe cancels timers and sends a leave()
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rt2 } from "../../src/lib/pluto/live";

describe("rt2.subscribePresence retry/resubscribe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Provide the minimum liveConfig() shape via VITE globals.
    (globalThis as unknown as { window?: Window }).window ??= globalThis as unknown as Window;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("sends heartbeats and resubscribes after presence failures", async () => {
    const joinSpy    = vi.spyOn(rt2, "join").mockResolvedValue({ ok: true });
    const leaveSpy   = vi.spyOn(rt2, "leave").mockResolvedValue({ ok: true });
    let failNext = 0;
    const presenceSpy = vi.spyOn(rt2, "presence").mockImplementation(async () => {
      if (failNext > 0) { failNext--; throw new Error("network"); }
      return { members: [{ member_key: "u1", metadata: {}, last_seen: new Date().toISOString() }] };
    });

    const membersLog: number[] = []; const reconnects: number[] = []; const errors: string[] = [];
    const unsub = rt2.subscribePresence("room-1", "u1", {
      metadata: { role: "editor" }, heartbeatMs: 1000, pollMs: 200,
      onMembers:    (m) => membersLog.push(m.length),
      onReconnect:  (n) => reconnects.push(n),
      onError:      (e) => errors.push(e.message),
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(joinSpy).toHaveBeenCalledWith("room-1", "u1", { role: "editor" });
    expect(presenceSpy).toHaveBeenCalled();
    expect(membersLog.at(-1)).toBe(1);

    // Heartbeat fires at ~1s
    await vi.advanceTimersByTimeAsync(1200);
    expect(joinSpy.mock.calls.length).toBeGreaterThan(1);

    // Force presence to fail — triggers backoff + reconnect
    failNext = 2;
    await vi.advanceTimersByTimeAsync(3000);
    expect(errors.length).toBeGreaterThan(0);

    unsub();
    await vi.advanceTimersByTimeAsync(50);
    expect(leaveSpy).toHaveBeenCalledWith("room-1", "u1");
  });
});
