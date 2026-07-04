// Contract tests for the plan enforcement middleware.
//
// The middleware should:
//   * return 402 { error: "plan_upgrade_required" } when the feature flag
//     is off on the caller's plan (or the numeric limit is 0/missing).
//   * return 429 { error: "plan_limit_exceeded" } when current usage plus
//     the requested delta would exceed the limit.
//   * fall through (no reply.send) when the caller is within budget.

import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL     ??= "postgres://test/test";
process.env.JWT_SECRET       ??= "test-jwt-secret-please-ignore-32chars-min-xxxxxxx";
process.env.ANON_KEY         ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY ??= "service-test-key";

const planByWs: Record<string, { code: string; features: Record<string, unknown>; limits: Record<string, number> }> = {
  "ws-free": { code: "free",  features: {},                     limits: { storage_gb: 1, edge_fns: 0 } },
  "ws-pro":  { code: "pro",   features: { branching: true },    limits: { storage_gb: 50, edge_fns: 20 } },
};

vi.mock("../lib/pgraw.js", () => ({
  q: vi.fn(async (sql: string, params?: unknown[]) => {
    if (/from public\.billing_plans p/i.test(sql)) {
      const ws = params?.[0] as string | null;
      const plan = ws && planByWs[ws] ? planByWs[ws] : null;
      return plan ? { rows: [plan] } : { rows: [] };
    }
    return { rows: [] };
  }),
}));

const { requirePlanFeature, requirePlanLimit } = await import("../lib/plan-enforce.js");

type Captured = { code?: number; body?: unknown };
function makeReply(): Captured & { code: (n: number) => any; send: (b: unknown) => any } {
  const captured: Captured = {};
  return {
    ...captured,
    code(n: number) { (this as any).__code = n; captured.code = n; return this; },
    send(b: unknown) { captured.body = b; (this as any).__body = b; return this; },
    get __captured() { return captured; },
  } as any;
}
function makeReq(ws: string | null) {
  return { headers: ws ? { "x-workspace-id": ws } : {} } as any;
}

describe("requirePlanFeature", () => {
  it("passes through when the plan has the feature", async () => {
    const reply: any = makeReply();
    await requirePlanFeature("branching")(makeReq("ws-pro"), reply);
    expect(reply.__code).toBeUndefined();
  });

  it("returns 402 plan_upgrade_required on the free plan", async () => {
    const reply: any = makeReply();
    await requirePlanFeature("branching")(makeReq("ws-free"), reply);
    expect(reply.__code).toBe(402);
    expect(reply.__body).toMatchObject({
      error: "plan_upgrade_required",
      required_feature: "branching",
      current_plan: "free",
    });
  });

  it("treats a missing workspace as the free plan", async () => {
    const reply: any = makeReply();
    await requirePlanFeature("branching")(makeReq(null), reply);
    expect(reply.__code).toBe(402);
  });
});

describe("requirePlanLimit", () => {
  it("returns 402 when the limit is 0 (feature not included)", async () => {
    const reply: any = makeReply();
    await requirePlanLimit("edge_fns", () => 0)(makeReq("ws-free"), reply);
    expect(reply.__code).toBe(402);
    expect(reply.__body).toMatchObject({ error: "plan_upgrade_required", limit_key: "edge_fns" });
  });

  it("returns 429 when current + delta exceeds the limit", async () => {
    const reply: any = makeReply();
    await requirePlanLimit("edge_fns", () => 20, 1)(makeReq("ws-pro"), reply);
    expect(reply.__code).toBe(429);
    expect(reply.__body).toMatchObject({
      error: "plan_limit_exceeded",
      limit_key: "edge_fns",
      limit: 20, current: 20,
    });
  });

  it("passes through when there is headroom", async () => {
    const reply: any = makeReply();
    await requirePlanLimit("edge_fns", () => 5, 1)(makeReq("ws-pro"), reply);
    expect(reply.__code).toBeUndefined();
  });
});
