// Contract tests for the Stripe webhook signature helper and event
// dispatcher. These tests do NOT hit the network or a live database —
// `q` is stubbed with vi.mock so we can assert the exact SQL branch
// taken for upgrade / downgrade / payment_failed events.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL     ??= "postgres://test/test";
process.env.JWT_SECRET       ??= "test-jwt-secret-please-ignore-32chars-min-xxxxxxx";
process.env.ANON_KEY         ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY ??= "service-test-key";
process.env.PLUTO_ENABLE_BILLING ??= "1";

vi.mock("../lib/apikey.js", () => ({
  requireApiKey: async () => {},
  requireServiceRole: async () => {},
  requireWorkspaceAdmin: async () => {},
}));

vi.mock("../lib/pgraw.js", () => ({
  q: vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    if (/from public\.billing_plans p/i.test(sql)) {
      // getWorkspacePlan lookup — no active sub → fall through to free.
      return { rows: [] };
    }
    return { rows: [{ id: "00000000-0000-0000-0000-000000000000" }] };
  }),
}));

const { verifyStripeSig, signStripePayload } = await import("../lib/stripe-sig.js");
const { applyStripeEvent } = await import("../modules/billing/plugin.js");

const SECRET = "whsec_test_secret_for_unit_tests_only";

describe("stripe signature verification", () => {
  it("accepts a well-formed signature we just produced", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "ping" });
    const header = signStripePayload(payload, SECRET);
    expect(verifyStripeSig(header, payload, SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const payload = "{}";
    const header = signStripePayload(payload, SECRET);
    expect(verifyStripeSig(header, payload, "wrong")).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const header = signStripePayload("{}", SECRET);
    expect(verifyStripeSig(header, '{"tampered":true}', SECRET)).toBe(false);
  });

  it("rejects a stale timestamp outside tolerance", () => {
    const payload = "{}";
    const old = Math.floor(Date.now() / 1000) - 10_000;
    const header = signStripePayload(payload, SECRET, old);
    expect(verifyStripeSig(header, payload, SECRET, 300)).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifyStripeSig("not-a-header", "{}", SECRET)).toBe(false);
  });
});

describe("applyStripeEvent", () => {
  beforeEach(() => { calls.length = 0; });

  it("upgrades a workspace on checkout.session.completed", async () => {
    const r = await applyStripeEvent({
      id: "evt_up",
      type: "checkout.session.completed",
      data: { object: {
        customer: "cus_1", subscription: "sub_1",
        metadata: { workspace_id: "11111111-1111-1111-1111-111111111111", plan_code: "pro" },
      } },
    });
    expect(r.handled).toBe(true);
    expect(calls.some((c) => /insert into public\.billing_subscriptions/i.test(c.sql))).toBe(true);
    const insert = calls.find((c) => /insert into public\.billing_subscriptions/i.test(c.sql))!;
    expect(insert.params).toContain("pro");
    expect(insert.params).toContain("cus_1");
  });

  it("downgrades a workspace on customer.subscription.updated", async () => {
    const r = await applyStripeEvent({
      id: "evt_down",
      type: "customer.subscription.updated",
      data: { object: {
        id: "sub_1", status: "active",
        current_period_end: 1_700_000_000,
        items: { data: [{ price: { lookup_key: "starter" } }] },
        metadata: {},
      } },
    });
    expect(r.handled).toBe(true);
    const update = calls.find((c) => /update public\.billing_subscriptions[\s\S]*plan_code=coalesce/i.test(c.sql))!;
    expect(update).toBeDefined();
    expect(update.params).toContain("starter");
    expect(update.params).toContain("sub_1");
  });

  it("marks past_due on invoice.payment_failed", async () => {
    const r = await applyStripeEvent({
      id: "evt_fail",
      type: "invoice.payment_failed",
      data: { object: { subscription: "sub_1" } },
    });
    expect(r.handled).toBe(true);
    const update = calls.find((c) => /set status='past_due'/i.test(c.sql))!;
    expect(update).toBeDefined();
    expect(update.params).toContain("sub_1");
  });

  it("no-ops on unhandled event types", async () => {
    const r = await applyStripeEvent({
      id: "evt_x", type: "product.created",
      data: { object: {} },
    });
    expect(r.handled).toBe(false);
    expect(r.reason).toBe("unhandled_event_type");
  });

  it("skips payment_failed without a subscription id", async () => {
    const r = await applyStripeEvent({
      id: "evt_no_sub", type: "invoice.payment_failed",
      data: { object: { subscription: null } },
    });
    expect(r.handled).toBe(false);
  });
});
