// Replays the same Stripe event across the full ±300s signature-timestamp
// tolerance window and asserts:
//   1. Every replay is accepted at the transport layer (signature valid).
//   2. Only the FIRST call runs the business handler (applyStripeEvent),
//      because our `insert ... on conflict (stripe_event_id) do nothing`
//      short-circuits the duplicate branch.
//   3. Two events with the SAME id but DIFFERENT timestamps still count
//      as a single logical event (idempotency is keyed on event id, not
//      on timestamp).

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL          ??= "postgres://test/test";
process.env.JWT_SECRET            ??= "test-jwt-secret-please-ignore-32chars-min-xxxxxxx";
process.env.ANON_KEY              ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY      ??= "service-test-key";
process.env.PLUTO_ENABLE_BILLING  ??= "1";
process.env.STRIPE_WEBHOOK_SECRET  = "whsec_replay_window_secret";

vi.mock("../lib/apikey.js", () => ({
  requireApiKey: async () => {},
  requireServiceRole: async () => {},
  requireWorkspaceAdmin: async () => {},
}));

const seen = new Set<string>();
const applyCalls: string[] = [];
vi.mock("../lib/pgraw.js", () => ({
  q: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/insert into public\.billing_events/i.test(sql)) {
      const evtId = String(params[1] ?? "");
      if (seen.has(evtId)) return { rows: [] };
      seen.add(evtId);
      return { rows: [{ id: "row-" + evtId }] };
    }
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
beforeEach(() => { seen.clear(); applyCalls.length = 0; });

function post(payload: string, sig: string) {
  return app.inject({
    method: "POST", url: "/billing/v1/webhook",
    headers: { "content-type": "application/json", "stripe-signature": sig },
    payload,
  });
}

// Points spanning the full accepted window plus a couple just-inside edges.
// verifyStripeSig uses toleranceSec=300 by default, so ±300 must succeed
// at the transport layer. We deliberately include t=0 (now) twice to
// exercise exact-duplicate replay as well.
const OFFSETS_SEC = [-300, -299, -180, -60, -1, 0, 0, 1, 60, 180, 299, 300];

describe("stripe webhook — replay across the full ±300s tolerance window", () => {
  it("processes the event exactly once even when replayed at every offset in the window", async () => {
    const payload = JSON.stringify({
      id: "evt_replay_window",
      type: "checkout.session.completed",
      data: { object: {
        customer: "cus_r", subscription: "sub_r",
        metadata: { workspace_id: "22222222-2222-2222-2222-222222222222", plan_code: "pro" },
      } },
    });
    const now = Math.floor(Date.now() / 1000);

    const results = await Promise.all(
      OFFSETS_SEC.map((off) => post(payload, signStripePayload(payload, SECRET, now + off))),
    );

    // Every replay is accepted at the transport layer.
    for (const r of results) expect(r.statusCode).toBe(200);

    // Exactly one call ran the business logic; every other replay is
    // reported back as { ok: true, duplicate: true }.
    const duplicates = results.filter((r) => (r.json() as { duplicate?: boolean }).duplicate === true);
    const fresh      = results.filter((r) => (r.json() as { duplicate?: boolean }).duplicate !== true);
    expect(fresh.length).toBe(1);
    expect(duplicates.length).toBe(OFFSETS_SEC.length - 1);
    expect(applyCalls.length).toBe(1);
  });

  it("idempotency is keyed on stripe event id, not on signature timestamp", async () => {
    const payload = JSON.stringify({
      id: "evt_ts_shift",
      type: "invoice.payment_failed",
      data: { object: { subscription: "sub_r" } },
    });
    const now = Math.floor(Date.now() / 1000);
    const r1 = await post(payload, signStripePayload(payload, SECRET, now - 250));
    const r2 = await post(payload, signStripePayload(payload, SECRET, now));
    const r3 = await post(payload, signStripePayload(payload, SECRET, now + 250));

    expect(r1.json()).toEqual({ ok: true });
    expect(r2.json()).toEqual({ ok: true, duplicate: true });
    expect(r3.json()).toEqual({ ok: true, duplicate: true });
    expect(applyCalls.length).toBe(1);
  });

  it("near-window-edge exact duplicates (same t, same payload) still collapse to one", async () => {
    const payload = JSON.stringify({
      id: "evt_edge_dup",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_edge", status: "active", current_period_end: 9999999999 } },
    });
    const edgeTs = Math.floor(Date.now() / 1000) - 299;
    const sig = signStripePayload(payload, SECRET, edgeTs);

    const r1 = await post(payload, sig);
    const r2 = await post(payload, sig);
    const r3 = await post(payload, sig);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ ok: true });
    expect(r2.json()).toEqual({ ok: true, duplicate: true });
    expect(r3.json()).toEqual({ ok: true, duplicate: true });
    expect(applyCalls.length).toBe(1);
  });
});
