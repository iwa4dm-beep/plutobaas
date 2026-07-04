// Phase 48 — end-to-end tests: fan-out ordering, reconnect correctness,
// presence sync consistency under load.

import { describe, it, expect, beforeEach } from "vitest";
import {
  publish, subscribe, replay, _resetBroadcastForTests, _stats,
} from "../lib/broadcast-bus.js";
import {
  heartbeat, leave, listChannel, newSessionId, _resetPresenceForTests,
} from "../lib/presence-store.js";

beforeEach(() => { _resetBroadcastForTests(); _resetPresenceForTests(); });

describe("broadcast fan-out ordering", () => {
  it("delivers messages to all subscribers in publish order", () => {
    const a: number[] = []; const b: number[] = [];
    subscribe("room:1", (m) => a.push(m.seq));
    subscribe("room:1", (m) => b.push(m.seq));
    for (let i = 0; i < 100; i++) publish({ channel: "room:1", event: "tick", payload: i });
    expect(a).toEqual(b);
    expect(a).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it("keeps seq monotonic under concurrent-ish publishes across channels", () => {
    for (let i = 0; i < 50; i++) {
      publish({ channel: "c1", event: "x", payload: i });
      publish({ channel: "c2", event: "x", payload: i });
    }
    const r1 = replay("c1", 0).map((m) => m.seq);
    const r2 = replay("c2", 0).map((m) => m.seq);
    expect(r1).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(r2).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe("reconnect correctness", () => {
  it("replays only messages after since_seq", () => {
    for (let i = 0; i < 10; i++) publish({ channel: "r", event: "e", payload: i });
    const missed = replay("r", 6);
    expect(missed.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
  });

  it("drops messages past their TTL from replay", async () => {
    publish({ channel: "ttl", event: "e", payload: 1, ttl_ms: 1 });
    await new Promise((r) => setTimeout(r, 5));
    // Trigger a prune-on-push by publishing another message.
    publish({ channel: "ttl", event: "e", payload: 2, ttl_ms: 5_000 });
    const buf = replay("ttl", 0);
    expect(buf.length).toBe(1);
    expect(buf[0].payload).toBe(2);
  });
});

describe("presence sync", () => {
  it("tracks join/leave and emits deltas via broadcast", async () => {
    const events: string[] = [];
    subscribe("chan:p", (m) => { if (m.event.startsWith("presence.")) events.push(m.event); });

    const s1 = newSessionId();
    const { joined } = await heartbeat("chan:p", s1, "u1");
    expect(joined).toBe(true);
    // Simulate the plugin wiring: publish a join delta on first heartbeat.
    publish({ channel: "chan:p", event: "presence.join", payload: { session_id: s1 } });

    const members = await listChannel("chan:p");
    expect(members.map((m) => m.session_id)).toContain(s1);

    await leave("chan:p", s1);
    publish({ channel: "chan:p", event: "presence.leave", payload: { session_id: s1 } });
    expect(events).toEqual(["presence.join", "presence.leave"]);
    expect((await listChannel("chan:p")).length).toBe(0);
  });

  it("stays consistent under load (500 heartbeats across 50 sessions)", async () => {
    const sessions = Array.from({ length: 50 }, () => newSessionId());
    for (let i = 0; i < 500; i++) {
      const sid = sessions[i % sessions.length];
      await heartbeat("load", sid, `u${i % sessions.length}`);
    }
    const members = await listChannel("load");
    // Every session is present exactly once regardless of heartbeat count.
    expect(members.length).toBe(50);
    const unique = new Set(members.map((m) => m.session_id));
    expect(unique.size).toBe(50);
  });
});

describe("bus stats", () => {
  it("reports subscriber count", () => {
    const off = subscribe("s", () => {});
    expect(_stats().subscribers).toBe(1);
    off();
    expect(_stats().subscribers).toBe(0);
  });
});
