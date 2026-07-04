// Phase 61 — Playwright e2e for Vector v3.
// Skips unless PLUTO_ENABLE_VECTOR_V3=1.
import { test, expect } from "@playwright/test";

const BASE = process.env.PLUTO_API_BASE ?? "http://localhost:8080";
const API_KEY = process.env.PLUTO_API_KEY ?? "dev-anon";
const enabled = process.env.PLUTO_ENABLE_VECTOR_V3 === "1";
const WS = "00000000-0000-0000-0000-000000000061";
const H = { apikey: API_KEY, "x-workspace-id": WS, "content-type": "application/json" };

test.describe("vector v3 e2e", () => {
  test.skip(!enabled, "PLUTO_ENABLE_VECTOR_V3=1 required");

  test("per-tenant HNSW config round-trip and DDL", async ({ request }) => {
    const r = await request.post(`${BASE}/vec/v3/hnsw/config`, {
      headers: H, data: { index_name: `e2e_idx_${Date.now()}`, m: 20, ef_construction: 250 },
    });
    expect(r.ok()).toBeTruthy();
    const cfg = (await r.json()).config;
    const ddl = await request.get(`${BASE}/vec/v3/hnsw/${cfg.index_name}/ddl?table=documents&column=embedding`, { headers: H });
    expect((await ddl.json()).ddl).toMatch(/m = 20/);
  });

  test("hybrid search is deterministic across repeated calls", async ({ request }) => {
    const body = {
      candidates: [
        { id: "a", vector_score: 0.8, lexical_score: 0.2 },
        { id: "b", vector_score: 0.4, lexical_score: 0.7 },
        { id: "c", vector_score: 0.4, lexical_score: 0.7 },
      ],
      strategy: "linear", alpha: 0.5,
    };
    const r1 = await (await request.post(`${BASE}/vec/v3/hybrid/search`, { headers: H, data: body })).json();
    const r2 = await (await request.post(`${BASE}/vec/v3/hybrid/search`, { headers: H, data: body })).json();
    expect(r1.results.map((x: { id: string }) => x.id)).toEqual(r2.results.map((x: { id: string }) => x.id));
    // "b" < "c" on id tiebreak
    const bIdx = r1.results.findIndex((x: { id: string }) => x.id === "b");
    const cIdx = r1.results.findIndex((x: { id: string }) => x.id === "c");
    expect(bIdx).toBeLessThan(cIdx);
  });

  test("streaming embeddings returns NDJSON with per-input rows", async ({ request }) => {
    const r = await request.post(`${BASE}/vec/v3/embeddings/stream`, {
      headers: H, data: { inputs: ["one", "two", "three"], batch_size: 2 },
    });
    expect(r.ok()).toBeTruthy();
    const text = await r.text();
    const frames = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(frames.filter((f) => f.type === "row").length).toBe(3);
    expect(frames[frames.length - 1].type).toBe("end");
  });
});
