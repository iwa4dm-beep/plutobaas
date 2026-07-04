// Phase 58 — Playwright e2e for Observability v3 (traceparent propagation,
// live audit tail, SLO incident surface). Skips unless both
// PLUTO_ENABLE_OBSERVABILITY_V3=1 and PLUTO_ENABLE_AUTH_V4=1 are set.
import { test, expect } from "@playwright/test";

const BASE = process.env.PLUTO_API_BASE ?? "http://localhost:8080";
const API_KEY = process.env.PLUTO_API_KEY ?? "dev-anon";
const enabled = process.env.PLUTO_ENABLE_OBSERVABILITY_V3 === "1" && process.env.PLUTO_ENABLE_AUTH_V4 === "1";
const WS = "00000000-0000-0000-0000-0000000000e2";
const H  = { apikey: API_KEY, "x-workspace-id": WS };
const HA = { ...H, "x-role": "admin" };

test.describe("observability v3 e2e", () => {
  test.skip(!enabled, "PLUTO_ENABLE_OBSERVABILITY_V3=1 and PLUTO_ENABLE_AUTH_V4=1 required");

  test("traceparent header is echoed back and lookup returns the span", async ({ request }) => {
    const tp = "00-11112222333344445555666677778888-aaaabbbbccccdddd-01";
    const r = await request.get(`${BASE}/auth/v4/audit/events`, { headers: { ...H, traceparent: tp } });
    expect(r.ok()).toBeTruthy();
    expect(r.headers()["traceparent"]).toMatch(/^00-11112222333344445555666677778888-[0-9a-f]{16}-01$/);
    const trace = await request.get(`${BASE}/obs/v3/traces/11112222333344445555666677778888`, { headers: H });
    expect(trace.ok()).toBeTruthy();
    expect((await trace.json()).spans.length).toBeGreaterThan(0);
  });

  test("audit event carries the trace_id of its originating request", async ({ request }) => {
    const tp = "00-99998888777766665555444433332211-1111222233334444-01";
    // Send a request that mints an audit event (SCIM create).
    const uname = `u-${Date.now()}@e.io`;
    const created = await request.post(`${BASE}/auth/v4/scim/v2/Users`, {
      headers: { ...HA, traceparent: tp }, data: { userName: uname },
    });
    expect(created.status()).toBe(201);
    const events = await request.get(`${BASE}/auth/v4/audit/events?action=scim.user_create`, { headers: H });
    const list = (await events.json()).events;
    expect(list.some((e: { trace_id?: string }) => e.trace_id === "99998888777766665555444433332211")).toBe(true);
  });

  test("SLO incidents endpoint is reachable and returns array", async ({ request }) => {
    const r = await request.get(`${BASE}/obs/v3/slo/incidents`, { headers: H });
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray((await r.json()).incidents)).toBe(true);
  });
});
