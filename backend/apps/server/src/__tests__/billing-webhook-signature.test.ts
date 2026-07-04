// Negative-path signature tests for the Stripe webhook. We assert that
// invalid, missing, malformed, or expired signatures are rejected with
// `400 { error: "bad_signature" }` AND — critically — that the handler
// short-circuits BEFORE persisting anything to public.billing_events.
//
// Persistence is observed via a spy on the mocked `q` from lib/pgraw:
// if the handler ever reaches the `insert into public.billing_events`
// branch, we would see the SQL in `sqlLog`. A rejected request must
// leave that log empty.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

process.env.DATABASE_URL          ??= "postgres://test/test";
process.env.JWT_SECRET            ??= "test-jwt-secret-please-ignore-32chars-min-xxxxxxx";
process.env.ANON_KEY              ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY      ??= "service-test-key";
process.env.PLUTO_ENABLE_BILLING  ??= "1";
process.env.STRIPE_WEBHOOK_SECRET  = "whsec_sig_negative_secret";

vi.mock("../lib/apikey.js", () => ({
  requireApiKey: async () => {},
  requireServiceRole: async () => {},
  requireWorkspaceAdmin: async () => {},
}));

const sqlLog: string[] = [];
vi.mock("../lib/pgraw.js", () => ({
  q: vi.fn(async (sql: string) => {
    sqlLog.push(sql);
    // We should NEVER reach the INSERT branch for a rejected request,
    // but return a plausible shape just in case so a bug produces a
    // clearer test failure than a crash.
    if (/insert into public\.billing_events/i.test(sql)) return { rows: [{ id: "row" }] };
    return { rows: [] };
  }),
}));

const [{ default: Fastify }, { billingPlugin }, { signStripePayload }] = await Promise.all([
  import("fastify"),
  import("../modules/billing/plugin.js"),
  import("../lib/stripe-sig.js"),
]);

const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const body = JSON.stringify({ id: "evt_neg", type: "ping", data: { object: {} } });

let app: Awaited<ReturnType<typeof Fastify>>;
beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(billingPlugin);
  await app.ready();
});
beforeEach(() => { sqlLog.length = 0; });

function post(payload: string, sig: string | undefined) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== undefined) headers["stripe-signature"] = sig;
  return app.inject({ method: "POST", url: "/billing/v1/webhook", headers, payload });
}

function expectRejected(status: number, r: Awaited<ReturnType<typeof post>>) {
  expect(r.statusCode).toBe(status);
  expect(r.json()).toEqual({ error: "bad_signature" });
  // No billing side-effects should have happened.
  expect(sqlLog.some((s) => /billing_events|billing_subscriptions/i.test(s))).toBe(false);
}

describe("stripe webhook — invalid signature rejection has no side effects", () => {
  it("missing Stripe-Signature header", async () => {
    expectRejected(400, await post(body, undefined));
  });

  it("empty Stripe-Signature header", async () => {
    expectRejected(400, await post(body, ""));
  });

  it("header missing v1= segment", async () => {
    const ts = Math.floor(Date.now() / 1000);
    expectRejected(400, await post(body, `t=${ts}`));
  });

  it("header missing t= segment (no timestamp)", async () => {
    const mac = createHmac("sha256", SECRET).update(`0.${body}`).digest("hex");
    expectRejected(400, await post(body, `v1=${mac}`));
  });

  it("non-numeric timestamp is rejected", async () => {
    const mac = createHmac("sha256", SECRET).update(`notanumber.${body}`).digest("hex");
    expectRejected(400, await post(body, `t=notanumber,v1=${mac}`));
  });

  it("valid shape but signed with the WRONG secret", async () => {
    const bad = signStripePayload(body, "whsec_wrong_secret_zzz");
    expectRejected(400, await post(body, bad));
  });

  it("valid signature for a DIFFERENT payload (tamper-after-sign)", async () => {
    const sig = signStripePayload(body, SECRET);
    expectRejected(400, await post(body + " ", sig));
  });

  it("v1 hex of the wrong length (short digest)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    expectRejected(400, await post(body, `t=${ts},v1=deadbeef`));
  });

  it("timestamp exactly at the far edge of tolerance is rejected (301s old)", async () => {
    const ts = Math.floor(Date.now() / 1000) - 301;
    expectRejected(400, await post(body, signStripePayload(body, SECRET, ts)));
  });

  it("timestamp 24h in the future is rejected", async () => {
    const ts = Math.floor(Date.now() / 1000) + 86_400;
    expectRejected(400, await post(body, signStripePayload(body, SECRET, ts)));
  });

  it("garbage header ('lol') is rejected without touching the db", async () => {
    expectRejected(400, await post(body, "lol"));
  });
});
