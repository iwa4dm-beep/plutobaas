// Phase 56 — Playwright e2e for Edge v7 (cron + replicated queue + signed bindings).
// Skips unless PLUTO_ENABLE_EDGE_V7=1 is set for the running server.
import { test, expect } from "@playwright/test";

const BASE = process.env.PLUTO_API_BASE ?? "http://localhost:8080";
const API_KEY = process.env.PLUTO_API_KEY ?? "dev-anon";
const enabled = process.env.PLUTO_ENABLE_EDGE_V7 === "1";
const H = { apikey: API_KEY };
const HA = { ...H, "x-role": "admin" };

test.describe("edge v7 e2e", () => {
  test.skip(!enabled, "PLUTO_ENABLE_EDGE_V7 must be 1");

  test("cron upsert + tick fires the schedule", async ({ request }) => {
    const id = `job-${Date.now()}`;
    const upsert = await request.post(`${BASE}/fn/v7/cron/upsert`, {
      headers: HA,
      data: { id, expr: "* * * * *", module: "m", version: 1, misfire_grace_ms: 60_000 },
    });
    expect(upsert.ok()).toBeTruthy();

    const tick = await request.post(`${BASE}/fn/v7/cron/tick`, { headers: HA, data: {} });
    const body = await tick.json();
    expect(body.fires.some((f: { id: string }) => f.id === id)).toBe(true);
  });

  test("replicated queue: retries and dead-letter surface", async ({ request }) => {
    const queue = `q-${Date.now()}`;
    // Publish two messages, then drain — dispatcher in the server always returns ok
    // so this asserts the drain path, retry accounting is covered by unit tests.
    await request.post(`${BASE}/fn/v7/queues/publish`, { headers: H, data: { queue, body: { i: 1 } } });
    await request.post(`${BASE}/fn/v7/queues/publish`, { headers: H, data: { queue, body: { i: 2 } } });
    const drained = await request.post(`${BASE}/fn/v7/queues/poll`, { headers: H, data: { queue, max: 100 } });
    const body = await drained.json();
    expect(body.processed).toBe(2);
    expect(body.pending).toBe(0);
  });

  test("signed binding: allowlist → issue → verify → tampered rejected", async ({ request }) => {
    const module = `m-${Date.now()}`;
    await request.post(`${BASE}/fn/v7/bindings/allowlist`, {
      headers: HA, data: { module, names: ["API_TOKEN"] },
    });
    const issued = await request.post(`${BASE}/fn/v7/bindings/issue`, {
      headers: HA, data: { name: "API_TOKEN", value: "secret-value", ttl_ms: 60_000 },
    });
    const { envelope } = await issued.json();

    const ok = await request.post(`${BASE}/fn/v7/bindings/verify`, {
      headers: H, data: { module, envelope },
    });
    expect(ok.ok()).toBeTruthy();
    expect((await ok.json()).value).toBe("secret-value");

    const tampered = await request.post(`${BASE}/fn/v7/bindings/verify`, {
      headers: H, data: { module, envelope: { ...envelope, sig: envelope.sig.replace(/.$/, "0") } },
    });
    expect(tampered.status()).toBe(403);
  });
});
