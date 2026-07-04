// Phase 60 integration tests — Realtime v5 HTTP surface via Fastify inject.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import * as ps from "../lib/presence-shard.js";
import * as od from "../lib/ordered-delivery.js";
import * as bp from "../lib/room-backpressure.js";

const WS = "00000000-0000-0000-0000-000000000060";
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PLUTO_ENABLE_REALTIME_V5 = "1";
  const { realtimeV5Plugin } = await import("../modules/realtime_v5/plugin.js");
  app = Fastify();
  await app.register(realtimeV5Plugin);
  await app.ready();
});

beforeEach(() => { ps._resetPresenceForTests(); od._resetOrderedForTests(); bp._resetBackpressureForTests(); });

const H = { "content-type": "application/json", "x-workspace-id": WS };
const post = (url: string, body: unknown) => app.inject({ method: "POST", url, headers: H, payload: JSON.stringify(body) });
const get = (url: string) => app.inject({ method: "GET", url, headers: H });

describe("realtime v5 presence over HTTP", () => {
  it("upserts and lists room members with shard information", async () => {
    const r = await post("/rt/v5/presence", { room: "team", user_id: "u1", status: "online" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.shard).toBeGreaterThanOrEqual(0);
    const list = await get("/rt/v5/presence/team");
    expect(JSON.parse(list.body).members).toHaveLength(1);
  });
});

describe("realtime v5 ordered delivery over HTTP", () => {
  it("re-orders out-of-order publishes and delivers to subscribers", async () => {
    const sub = JSON.parse((await post("/rt/v5/subscribe", { room: "chat" })).body).id;
    await post("/rt/v5/publish", { room: "chat", seq: 2, id: "b", payload: "B" });
    await post("/rt/v5/publish", { room: "chat", seq: 3, id: "c", payload: "C" });
    await post("/rt/v5/publish", { room: "chat", seq: 1, id: "a", payload: "A" });
    const drained = JSON.parse((await get(`/rt/v5/drain/${sub}`)).body).messages as { payload: string; seq: number }[];
    expect(drained.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(drained.map((m) => m.payload)).toEqual(["A", "B", "C"]);
  });

  it("drops a duplicate id publish", async () => {
    await post("/rt/v5/publish", { room: "chat", seq: 1, id: "dup", payload: 1 });
    const r = await post("/rt/v5/publish", { room: "chat", seq: 1, id: "dup", payload: 1 });
    expect(JSON.parse(r.body).dropped_reason).toBe("duplicate");
  });
});

describe("realtime v5 backpressure over HTTP", () => {
  it("drop_oldest keeps the tail after overflow", async () => {
    const sub = JSON.parse((await post("/rt/v5/subscribe", { room: "flood", policy: "drop_oldest", max_queue: 3 })).body).id;
    for (let i = 1; i <= 6; i++) await post("/rt/v5/publish", { room: "flood", seq: i, id: `m${i}`, payload: i });
    const drained = JSON.parse((await get(`/rt/v5/drain/${sub}`)).body).messages as { seq: number }[];
    expect(drained.map((m) => m.seq)).toEqual([4, 5, 6]);
  });

  it("pause policy stops delivery until /resume is called", async () => {
    const sub = JSON.parse((await post("/rt/v5/subscribe", { room: "slow", policy: "pause", max_queue: 2 })).body).id;
    for (let i = 1; i <= 4; i++) await post("/rt/v5/publish", { room: "slow", seq: i, id: `p${i}`, payload: i });
    let stats = JSON.parse((await get(`/rt/v5/drain/${sub}?n=0`)).body).stats;
    expect(stats.paused).toBe(true);
    await get(`/rt/v5/drain/${sub}`); // clear queue
    const resume = await post(`/rt/v5/resume/${sub}`, {});
    expect(resume.statusCode).toBe(200);
    await post("/rt/v5/publish", { room: "slow", seq: 5, id: "p5", payload: 5 });
    const after = JSON.parse((await get(`/rt/v5/drain/${sub}`)).body).messages as { seq: number }[];
    expect(after.map((m) => m.seq)).toEqual([5]);
  });
});
