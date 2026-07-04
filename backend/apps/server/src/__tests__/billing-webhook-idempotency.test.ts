// Idempotency + signature-timestamp tolerance tests for the Stripe
// webhook route. We boot a real Fastify app with the billing plugin
// registered and stub `q` so we can control the outcome of the
// `insert into public.billing_events ... on conflict do nothing`
// INSERT that gives us idempotency.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL          ??= "postgres://test/test";
process.env.JWT_SECRET            ??= "test-jwt-secret-please-ignore-32chars-min-xxxxxxx";
process.env.ANON_KEY              ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY      ??= "service-test-key";
process.env.PLUTO_ENABLE_BILLING  ??= "1";
process.env.STRIPE_WEBHOOK_SECRET  = "whsec_it_tolerance_secret";

vi.mock("../lib/apikey.js", () => ({
  requireApiKey: async () => {},
  requireServiceRole: async () => {},
  requireWorkspaceAdmin: async () => {},
}));

// Track every INSERT/UPDATE the plugin issues. The critical branch for
// idempotency is the `insert into public.billing_events ... on conflict
// (stripe_event_id) do nothing returning id` — a fresh event returns a
// row, a duplicate returns rows: [].
const seenEventIds = new Set<string>();
const applyCalls: string[] = [];
vi.mock("../lib/pgraw.js", () => ({
  q: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/insert into public\.billing_events/i.test(sql)) {
      const evtId = String(params[1] ?? "");
      if (seenEventIds.has(evtId)) return { rows: [] };
      seenEventIds.add(evtId);
      return { rows: [{ id: "row-" + evtId }] };
    }
    if (/from public\.billing_plans p/i.test(sql)) return { rows: [] };
    // applyStripeEvent branches — count them so we can assert the
    // duplicate path DID NOT re-run business logic.
    if (/insert into public\.billing_subscriptions/i.test(sql) ||
        /update public\.billing_subscriptions/i.test(sql)) {
      applyCalls.push(sql.slice(0, 40));
    }
    return { rows: [] };
  }),
}));

const [{ default: Fastify }, { billingPlugin }, { signStripePayload }] = await Promise.all([
  import("fastify"),
  import("../modules/billing/plugin.js"),
  import("../lib/stripe-sig.js"),
]);

const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

let app: Awaited<ReturnType<typeof Fastify>>;
beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(billingPlugin);
  await app.ready();
});

beforeEach(() => { seenEventIds.clear(); applyCalls.length = 0; });

function post(body: string, sig: string) {
  return app.inject({
    method: "POST",
    url: "/billing/v1/webhook",
    headers: { "content-type": "application/json", "stripe-signature": sig },
    payload: body,
  });
}

describe("stripe webhook — idempotency", () => {
  it("processes a fresh event exactly once and marks duplicate replays", async () => {
    const payload = JSON.stringify({
      id: "evt_dup_1",
      type: "checkout.session.completed",
      data: { object: {
        customer: "cus_1", subscription: "sub_1",
        metadata: { workspace_id: "11111111-1111-1111-1111-111111111111", plan_code: "pro" },
      } },
    });
    const sig = signStripePayload(payload, SECRET);

    const first = await post(payload, sig);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    expect(applyCalls.length).toBe(1);

    // Same signed payload replayed twice — the second and third calls
    // must short-circuit before applyStripeEvent runs.
    const second = await post(payload, sig);
    const third  = await post(payload, sig);
    expect(second.json()).toEqual({ ok: true, duplicate: true });
    expect(third.json()).toEqual({ ok: true, duplicate: true });
    expect(applyCalls.length).toBe(1);
  });

  it("treats distinct event ids as distinct even if the type + payload match", async () => {
    const mk = (id: string) => JSON.stringify({
      id, type: "invoice.payment_failed",
      data: { object: { subscription: "sub_1" } },
    });
    const a = mk("evt_a"), b = mk("evt_b");
    await post(a, signStripePayload(a, SECRET));
    await post(b, signStripePayload(b, SECRET));
    expect(applyCalls.length).toBe(2);
  });
});

describe("stripe webhook — signature timestamp tolerance", () => {
  const body = JSON.stringify({ id: "evt_ts", type: "ping", data: { object: {} } });

  it("accepts a signature timestamped just inside the tolerance window", async () => {
    // Default tolerance in verifyStripeSig is 300s. A signature 4m old
    // must still verify — Stripe deliberately gives us a wide window so
    // clock skew never rejects real events.
    const ts = Math.floor(Date.now() / 1000) - 4 * 60;
    const sig = signStripePayload(body, SECRET, ts);
    const r = await post(body, sig);
    // We reach the applyStripeEvent branch; "ping" is unhandled which
    // still returns 200 { ok: true } after the idempotency insert.
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("rejects a signature timestamped 1h in the past (well outside 5m tolerance)", async () => {
    const ts = Math.floor(Date.now() / 1000) - 60 * 60;
    const sig = signStripePayload(body, SECRET, ts);
    const r = await post(body, sig);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "bad_signature" });
  });

  it("rejects a signature timestamped 1h in the future", async () => {
    const ts = Math.floor(Date.now() / 1000) + 60 * 60;
    const sig = signStripePayload(body, SECRET, ts);
    const r = await post(body, sig);
    expect(r.statusCode).toBe(400);
  });

  it("rejects a payload whose signature was minted for a different body (replay-with-tamper)", async () => {
    const sig = signStripePayload(body, SECRET);
    const r = await post('{"id":"evt_ts","type":"ping","tampered":true,"data":{"object":{}}}', sig);
    expect(r.statusCode).toBe(400);
  });

  it("rejects a missing Stripe-Signature header", async () => {
    const r = await app.inject({
      method: "POST", url: "/billing/v1/webhook",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(r.statusCode).toBe(400);
  });
});
