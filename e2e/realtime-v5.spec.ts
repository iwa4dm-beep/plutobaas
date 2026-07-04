// Phase 60 — Playwright e2e for Realtime v5.
// Skips unless PLUTO_ENABLE_REALTIME_V5=1.
import { test, expect } from "@playwright/test";

const BASE = process.env.PLUTO_API_BASE ?? "http://localhost:8080";
const API_KEY = process.env.PLUTO_API_KEY ?? "dev-anon";
const enabled = process.env.PLUTO_ENABLE_REALTIME_V5 === "1";
const WS = "00000000-0000-0000-0000-000000000060";
const H = { apikey: API_KEY, "x-workspace-id": WS, "content-type": "application/json" };

test.describe("realtime v5 e2e", () => {
  test.skip(!enabled, "PLUTO_ENABLE_REALTIME_V5=1 required");

  test("presence upsert reports a shard and appears in room listing", async ({ request }) => {
    const r = await request.post(`${BASE}/rt/v5/presence`, {
      headers: H, data: { room: "e2e-room", user_id: `u-${Date.now()}`, status: "online" },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(typeof body.shard).toBe("number");
    const list = await request.get(`${BASE}/rt/v5/presence/e2e-room`, { headers: H });
    expect((await list.json()).members.length).toBeGreaterThan(0);
  });

  test("out-of-order publishes are re-ordered before subscriber sees them", async ({ request }) => {
    const room = `ord-${Date.now()}`;
    const sub = (await (await request.post(`${BASE}/rt/v5/subscribe`, { headers: H, data: { room } })).json()).id;
    for (const seq of [3, 1, 2]) {
      await request.post(`${BASE}/rt/v5/publish`, { headers: H, data: { room, seq, id: `s${seq}`, payload: seq } });
    }
    const drained = await (await request.get(`${BASE}/rt/v5/drain/${sub}`, { headers: H })).json();
    const seqs = (drained.messages as { seq: number }[]).map((m) => m.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  test("backpressure with drop_oldest keeps the newest messages after overflow", async ({ request }) => {
    const room = `bp-${Date.now()}`;
    const sub = (await (await request.post(`${BASE}/rt/v5/subscribe`, {
      headers: H, data: { room, policy: "drop_oldest", max_queue: 3 },
    })).json()).id;
    for (let i = 1; i <= 6; i++) {
      await request.post(`${BASE}/rt/v5/publish`, { headers: H, data: { room, seq: i, id: `m${i}`, payload: i } });
    }
    const drained = await (await request.get(`${BASE}/rt/v5/drain/${sub}`, { headers: H })).json();
    const seqs = (drained.messages as { seq: number }[]).map((m) => m.seq);
    expect(seqs).toEqual([4, 5, 6]);
  });
});
