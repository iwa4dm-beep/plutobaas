// Phase 56 — Edge v7 integration tests via Fastify inject.
// Boots a minimal Fastify instance with only the edge_v7 plugin mounted so
// cron + queue + signed-binding routes are exercised end-to-end without needing
// the full server stack.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { clearReplicated } from "../lib/replicated-queue.js";
import { clearCron } from "../lib/cron-scheduler.js";
import { clearBindings } from "../lib/signed-bindings.js";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.PLUTO_ENABLE_EDGE_V7 = "1";
  const { edgeV7Plugin } = await import("../modules/edge_v7/plugin.js");
  app = Fastify();
  // Stub auth hook so requireApiKey resolves without a real key setup.
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req) => {
    (req as unknown as { auth: unknown }).auth = { workspaceId: "w-int" };
  });
  // Bypass real requireApiKey by not mounting apikey plugin — plugin adds its own preHandler
  // but tests pass `apikey` header so behavior matches.
  await app.register(edgeV7Plugin);
  await app.ready();
});

beforeEach(() => { clearReplicated(); clearCron(); clearBindings(); });

async function inject(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: method as "POST",
    url,
    headers: { apikey: "test", "content-type": "application/json", ...headers },
    payload: body ? JSON.stringify(body) : undefined,
  });
}

describe("edge_v7 integration — cron + queue + bindings", () => {
  it("admin can upsert a cron schedule; non-admin gets 403", async () => {
    const noRole = await inject("POST", "/fn/v7/cron/upsert",
      { id: "job1", expr: "* * * * *", module: "m", version: 1, misfire_grace_ms: 60_000 });
    expect(noRole.statusCode).toBe(403);

    const ok = await inject("POST", "/fn/v7/cron/upsert",
      { id: "job1", expr: "* * * * *", module: "m", version: 1, misfire_grace_ms: 60_000 },
      { "x-role": "admin" });
    expect(ok.statusCode).toBe(200);

    const tick = await inject("POST", "/fn/v7/cron/tick", { now: Date.now() }, { "x-role": "admin" });
    expect(tick.statusCode).toBe(200);
    const body = tick.json() as { fires: unknown[] };
    expect(body.fires.length).toBeGreaterThan(0);
  });

  it("queue publish is idempotent by id and pending count reflects state", async () => {
    const r1 = await inject("POST", "/fn/v7/queues/publish", { queue: "q1", body: { a: 1 }, id: "same" });
    expect(r1.statusCode).toBe(200);
    await inject("POST", "/fn/v7/queues/publish", { queue: "q1", body: { a: 1 }, id: "same" });
    const pending = await inject("GET", "/fn/v7/queues/pending?queue=q1");
    expect(pending.json()).toEqual(expect.objectContaining({ pending: 1 }));
  });

  it("signed binding round-trip: issue, verify success, tamper → 403", async () => {
    await inject("POST", "/fn/v7/bindings/allowlist",
      { module: "mA", names: ["STRIPE_KEY"] }, { "x-role": "admin" });
    const issued = await inject("POST", "/fn/v7/bindings/issue",
      { name: "STRIPE_KEY", value: "sk_live_xxx", ttl_ms: 60_000 }, { "x-role": "admin" });
    const env = (issued.json() as { envelope: unknown }).envelope as { sig: string };

    const good = await inject("POST", "/fn/v7/bindings/verify", { module: "mA", envelope: env });
    expect(good.statusCode).toBe(200);
    expect((good.json() as { value: string }).value).toBe("sk_live_xxx");

    const bad = await inject("POST", "/fn/v7/bindings/verify",
      { module: "mA", envelope: { ...env, sig: env.sig.replace(/.$/, "0") } });
    expect(bad.statusCode).toBe(403);
  });

  it("queue-triggered flow: publish → poll drains → status shows 0 pending", async () => {
    await inject("POST", "/fn/v7/queues/publish", { queue: "q2", body: { n: 1 } });
    await inject("POST", "/fn/v7/queues/publish", { queue: "q2", body: { n: 2 } });
    const drained = await inject("POST", "/fn/v7/queues/poll", { queue: "q2", max: 100 });
    const body = drained.json() as { processed: number; pending: number };
    expect(body.processed).toBe(2);
    expect(body.pending).toBe(0);
  });
});
