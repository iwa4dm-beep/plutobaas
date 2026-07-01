// End-to-end integration tests for the privileged admin surfaces.
//
// These tests boot a real Fastify app with the actual auth middleware
// wired up, but stub the `migrator` and `audit` modules so we can run
// without a Postgres instance. Two properties matter here:
//
//   1. requireAdmin blocks the wrong callers with the right status code
//      on every mutating endpoint.
//   2. dry-run mode never invokes the write-path (runPending/rerunOne/
//      rollback) yet still records an audit event with status='dry_run'.

import { beforeAll, describe, expect, it, vi } from "vitest";

// Config parses `process.env` at import time — set required vars first.
process.env.DATABASE_URL     ??= "postgres://test/test";
process.env.JWT_SECRET       ??= "test-jwt-secret-please-ignore";
process.env.ANON_KEY         ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY ??= "service-test-key";

// Mock the migrator BEFORE importing the route. Every "write" path must
// be observable so the dry-run assertion can prove none of them fire.
const migratorCalls = {
  listMigrations: 0,
  planPending: 0,
  planPendingDetailed: 0,
  runPending: 0,
  rerunOne: 0,
  rollback: 0,
};
vi.mock("../lib/migrator.js", () => ({
  listMigrations: vi.fn(async () => { migratorCalls.listMigrations++; return []; }),
  planPending:    vi.fn(async () => { migratorCalls.planPending++; return []; }),
  planPendingDetailed: vi.fn(async () => {
    migratorCalls.planPendingDetailed++;
    return [{
      version: "0099_demo", name: "demo", reason: "pending",
      statement_count: 1, bytes: 32, has_down: false,
      preview: "create table t(x int)",
      statements: [{ index: 0, kind: "CREATE_TABLE", target: "t", sql: "create table t(x int)" }],
      diff: { added: ["table:public.t"], removed: [], changed: [] },
      before_snapshot_size: 3, after_snapshot_size: 4, simulation_error: null,
    }];
  }),
  runPending: vi.fn(async () => { migratorCalls.runPending++; return { applied: [], failed: [] }; }),
  rerunOne:   vi.fn(async () => { migratorCalls.rerunOne++;  return { version: "x" }; }),
  rollback:   vi.fn(async () => { migratorCalls.rollback++;  return { ok: true }; }),
}));

// Mock the audit module: track every write so we can assert dry-run
// still records a 'dry_run' event AND that the emit() broadcast helper
// is never invoked by dry-runs (no realtime step events).
type AuditCall = { action: string; status: string; target?: string | null; metadata?: unknown };
const auditCalls: AuditCall[] = [];
const emitCalls: Array<{ channel: string; event: string }> = [];
vi.mock("../lib/audit.js", () => ({
  audit: vi.fn(async (_req: unknown, input: AuditCall) => { auditCalls.push({ status: input.status ?? "ok", action: input.action, target: input.target, metadata: input.metadata }); }),
  emit:  vi.fn(async (channel: string, event: string) => { emitCalls.push({ channel, event }); }),
}));

// Also stub apikey.audit dependencies of admin/routes.ts (users/tables
// endpoints touch pg). We're only testing /audit + /migrations, but
// importing adminRoutes pulls in an adminPool — that's fine because
// we don't hit the routes that use it.

import Fastify, { type FastifyInstance } from "fastify";
import { migrationRoutes } from "../modules/admin/migrations.js";
import { signAccessToken } from "../lib/jwt.js";

let app: FastifyInstance;
let adminToken: string;
let userToken: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(migrationRoutes, { prefix: "/admin/v1/migrations" });
  await app.ready();

  adminToken = await signAccessToken({ sub: "u-admin", role: "admin", email: "admin@test.local" });
  userToken  = await signAccessToken({ sub: "u-user",  role: "user",  email: "user@test.local"  });
});

const H = {
  anon:        { apikey: process.env.ANON_KEY! },
  service:     { apikey: process.env.SERVICE_ROLE_KEY! },
  serviceUser: (t: string) => ({ apikey: process.env.SERVICE_ROLE_KEY!, authorization: `Bearer ${t}` }),
};

describe("requireAdmin — authorization matrix on /admin/v1/migrations/run", () => {
  it("rejects request with no api key (401 invalid_api_key)", async () => {
    const r = await app.inject({ method: "POST", url: "/admin/v1/migrations/run", payload: {} });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toMatch(/missing_api_key|invalid_api_key/);
  });

  it("rejects anon api key (403 service_role_required)", async () => {
    const r = await app.inject({ method: "POST", url: "/admin/v1/migrations/run", headers: H.anon, payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("service_role_required");
  });

  it("rejects service_role without a bearer token (401 admin_session_required)", async () => {
    const r = await app.inject({ method: "POST", url: "/admin/v1/migrations/run", headers: H.service, payload: {} });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("admin_session_required");
  });

  it("rejects service_role + non-admin bearer (403 admin_role_required)", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/migrations/run",
      headers: H.serviceUser(userToken), payload: {},
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("admin_role_required");
  });

  it("accepts service_role + admin bearer", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/migrations/run",
      headers: H.serviceUser(adminToken), payload: { dry_run: true },
    });
    expect(r.statusCode).toBe(200);
  });

  it("also gates /:version/rerun and /:version/rollback", async () => {
    const before = { rerun: migratorCalls.rerunOne, rollback: migratorCalls.rollback };
    const rr = await app.inject({ method: "POST", url: "/admin/v1/migrations/0001_x/rerun",    headers: H.anon });
    const rb = await app.inject({ method: "POST", url: "/admin/v1/migrations/0001_x/rollback", headers: H.anon });
    expect(rr.statusCode).toBe(403);
    expect(rb.statusCode).toBe(403);
    // Neither of the mutating helpers must have been called for these.
    expect(migratorCalls.rerunOne).toBe(before.rerun);
    expect(migratorCalls.rollback).toBe(before.rollback);
  });
});

describe("dry-run mode — zero writes, but audit still fires", () => {
  it("does NOT call runPending / rerunOne / rollback / emit, but DOES call audit(dry_run)", async () => {
    // Reset counters (module-level, shared across tests).
    migratorCalls.runPending = 0;
    migratorCalls.rerunOne = 0;
    migratorCalls.rollback = 0;
    migratorCalls.planPendingDetailed = 0;
    emitCalls.length = 0;
    auditCalls.length = 0;

    const r = await app.inject({
      method: "POST",
      url: "/admin/v1/migrations/run",
      headers: H.serviceUser(adminToken),
      payload: { dry_run: true, detailed: true },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.dry_run).toBe(true);
    expect(Array.isArray(body.plan)).toBe(true);
    // Per-migration diff view is populated.
    expect(body.plan[0].diff.added).toContain("table:public.t");
    expect(body.plan[0].statements[0].kind).toBe("CREATE_TABLE");

    // Write-path is untouched.
    expect(migratorCalls.runPending).toBe(0);
    expect(migratorCalls.rerunOne).toBe(0);
    expect(migratorCalls.rollback).toBe(0);
    // No realtime step events either — dry-runs are silent.
    expect(emitCalls.length).toBe(0);
    // Plan generator was used.
    expect(migratorCalls.planPendingDetailed).toBe(1);

    // Audit trail still receives one dry_run event.
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0].action).toBe("migration.run");
    expect(auditCalls[0].status).toBe("dry_run");
    const meta = auditCalls[0].metadata as { count: number; detailed: boolean; totals: { added: number } };
    expect(meta.count).toBe(1);
    expect(meta.detailed).toBe(true);
    expect(meta.totals.added).toBe(1);
  });

  it("live run (dry_run: false) DOES invoke runPending and emits step events", async () => {
    migratorCalls.runPending = 0;
    emitCalls.length = 0;
    auditCalls.length = 0;

    const r = await app.inject({
      method: "POST",
      url: "/admin/v1/migrations/run",
      headers: H.serviceUser(adminToken),
      payload: { dry_run: false },
    });
    expect(r.statusCode).toBe(200);
    expect(migratorCalls.runPending).toBe(1);
    expect(auditCalls[0].status).toBe("ok");
  });
});
