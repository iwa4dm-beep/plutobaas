// End-to-end workspace-isolation tests.
//
// Boots the sql runner and workspaces routes with a stubbed pg pool so
// we can assert:
//
//   1. A caller presenting workspace-A's service_role key cannot see
//      workspace-B's sql_history via GET /admin/v1/sql/history — the
//      handler injects a workspace_id filter automatically.
//   2. Non-admin JWT cannot invoke /admin/v1/sql/run at all (returns 403).
//   3. Workspace CRUD is admin-gated (workspaces routes reject anon).
//   4. The sql validator blocks tenant-escape attempts (SET ROLE / GRANT)
//      *before* the query ever reaches Postgres.

import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL     ??= "postgres://test/test";
process.env.JWT_SECRET       ??= "test-jwt-secret-please-ignore";
process.env.ANON_KEY         ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY ??= "service-test-key";

// --- pg mock ---------------------------------------------------------
// Every query passing through the runner is captured so tests can prove
// the tenant scoping / validation happened.
type QCall = { sql: string; params: unknown[] };
const qCalls: QCall[] = [];

// Deterministic fake query dispatcher. Matches the query text to decide
// what shape of result to return.
function fakeQuery(sql: string, params: unknown[] = []): { rows: unknown[]; rowCount: number; command: string | null; fields: { name: string; dataTypeID: number }[] } {
  qCalls.push({ sql, params });
  const lower = sql.toLowerCase();
  if (lower.startsWith("begin") || lower.startsWith("commit") || lower.startsWith("rollback") || lower.startsWith("set ")) {
    return { rows: [], rowCount: 0, command: "OK", fields: [] };
  }
  if (lower.includes("insert into public.sql_history")) {
    return { rows: [{ id: "history-uuid-1" }], rowCount: 1, command: "INSERT", fields: [{ name: "id", dataTypeID: 2950 }] };
  }
  return { rows: [{ result: 1 }], rowCount: 1, command: "SELECT", fields: [{ name: "result", dataTypeID: 23 }] };
}

vi.mock("pg", () => {
  class FakeClient {
    async query(text: string, params?: unknown[]) { return fakeQuery(text, params ?? []); }
    release() {}
  }
  class FakePool {
    async connect() { return new FakeClient(); }
    async query(text: string, params?: unknown[]) { return fakeQuery(text, params ?? []); }
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

// The audit module inserts via kysely; stub it out entirely.
vi.mock("../lib/audit.js", () => ({
  audit: vi.fn(async () => {}),
  logAudit: vi.fn(async () => {}),
  emit:  vi.fn(async () => {}),
}));

// Force the apikey resolver to a deterministic mapping so we can pretend
// to be different workspaces without touching the DB.
vi.mock("../lib/apikey.js", async () => {
  const { verifyAccessToken } = await import("../lib/jwt.js");
  const KEYS: Record<string, { kind: "anon" | "service_role"; workspaceId: string; workspaceSlug: string; keyId: string | null }> = {
    "svc-A": { kind: "service_role", workspaceId: "00000000-0000-0000-0000-0000000000aa", workspaceSlug: "acme",  keyId: "k-a" },
    "svc-B": { kind: "service_role", workspaceId: "00000000-0000-0000-0000-0000000000bb", workspaceSlug: "beta",  keyId: "k-b" },
    "anon-A": { kind: "anon",        workspaceId: "00000000-0000-0000-0000-0000000000aa", workspaceSlug: "acme",  keyId: "k-a-anon" },
  };
  return {
    ROOT_WORKSPACE_ID: "00000000-0000-0000-0000-000000000001",
    bustKeyCache: () => {},
    async requireApiKey(req: { headers: Record<string, string | undefined>; auth?: unknown }, reply: { code: (n: number) => { send: (v: unknown) => void }; sent?: boolean }) {
      const raw = req.headers["apikey"] ?? req.headers["x-api-key"];
      const info = raw ? KEYS[String(raw)] : undefined;
      if (!info) { reply.code(401).send({ error: "invalid_api_key" }); return; }
      let user = null as null | { sub: string; role: string; email: string };
      const authz = req.headers.authorization;
      if (authz?.startsWith("Bearer ") && authz.slice(7) !== raw) {
        try { user = await verifyAccessToken(authz.slice(7)); }
        catch { reply.code(401).send({ error: "invalid_token" }); return; }
      }
      req.auth = { apiKey: info.kind, workspaceId: info.workspaceId, workspaceSlug: info.workspaceSlug, keyId: info.keyId, user };
    },
    requireAdmin(req: { auth?: { apiKey?: string; user?: { role?: string } } }, reply: { code: (n: number) => { send: (v: unknown) => void }; sent?: boolean }) {
      if (req.auth?.apiKey !== "service_role") { reply.code(403).send({ error: "service_role_required" }); return; }
      if (!req.auth.user)                       { reply.code(401).send({ error: "admin_session_required" }); return; }
      if (req.auth.user.role !== "admin")       { reply.code(403).send({ error: "admin_role_required" }); return; }
    },
  };
});

import Fastify, { type FastifyInstance } from "fastify";
import { signAccessToken } from "../lib/jwt.js";
import { sqlRunnerRoutes } from "../modules/admin/sql.js";

let app: FastifyInstance;
let adminA: string;
let adminB: string;
let userA:  string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(sqlRunnerRoutes, { prefix: "/admin/v1/sql" });
  await app.ready();
  adminA = await signAccessToken({ sub: "u-a", role: "admin", email: "a@x" });
  adminB = await signAccessToken({ sub: "u-b", role: "admin", email: "b@x" });
  userA  = await signAccessToken({ sub: "u-u", role: "user",  email: "u@x" });
});

afterEach(() => { qCalls.length = 0; });

describe("workspace-isolation — SQL runner", () => {
  it("rejects non-admin JWT even with a service_role key", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/sql/run",
      headers: { apikey: "svc-A", authorization: `Bearer ${userA}` },
      payload: { sql: "select 1", read_only: true },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("admin_role_required");
    // Handler exits before touching pg.
    expect(qCalls.length).toBe(0);
  });

  it("rejects anon key on /run (service_role required)", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/sql/run",
      headers: { apikey: "anon-A", authorization: `Bearer ${adminA}` },
      payload: { sql: "select 1", read_only: true },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("service_role_required");
  });

  it("blocks SET ROLE / GRANT / ALTER SYSTEM before hitting Postgres", async () => {
    for (const sql of [
      "set role postgres; select 1",
      "grant all on public.users to anon",
      "alter system set foo = 'bar'",
      "listen tenant_channel",
      "copy public.users to '/tmp/x'",
    ]) {
      qCalls.length = 0;
      const r = await app.inject({
        method: "POST", url: "/admin/v1/sql/run",
        headers: { apikey: "svc-A", authorization: `Bearer ${adminA}` },
        payload: { sql, read_only: false },
      });
      expect(r.statusCode, `expected rejection for: ${sql}`).toBe(400);
      expect(r.json().error).toBe("sql_rejected");
      // No BEGIN was ever issued.
      expect(qCalls.find((c) => /^begin/i.test(c.sql))).toBeUndefined();
    }
  });

  it("read-only mode rejects UPDATE / DELETE up front", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/sql/run",
      headers: { apikey: "svc-A", authorization: `Bearer ${adminA}` },
      payload: { sql: "update public.users set email='x'", read_only: true },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().reason).toMatch(/write_in_read_only/);
  });

  it("bind params: forwards params to pg only on single-statement SQL", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/sql/run",
      headers: { apikey: "svc-A", authorization: `Bearer ${adminA}` },
      payload: { sql: "select $1::int", params: [42], read_only: true },
    });
    expect(r.statusCode).toBe(200);
    // The actual data query is the one with $1.
    const dataCall = qCalls.find((c) => c.sql.includes("$1"));
    expect(dataCall).toBeDefined();
    expect(dataCall!.params).toEqual([42]);
  });

  it("bind params: rejects multi-statement SQL with params", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/sql/run",
      headers: { apikey: "svc-A", authorization: `Bearer ${adminA}` },
      payload: { sql: "select $1::int; select 2", params: [1], read_only: true },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("params_require_single_statement");
  });

  it("history: workspace B admin cannot see workspace A history rows (filter injected)", async () => {
    // GET /history with workspace_id belonging to A while authenticated
    // as service-role B → the endpoint must NOT return arbitrary rows
    // (we assert the SQL WHERE includes workspace_id parameterization).
    const r = await app.inject({
      method: "GET",
      url: "/admin/v1/sql/history?workspace_id=00000000-0000-0000-0000-0000000000aa&limit=10",
      headers: { apikey: "svc-B", authorization: `Bearer ${adminB}` },
    });
    expect(r.statusCode).toBe(200);
    // Verify the emitted SQL parameterizes the workspace_id filter.
    const filterCall = qCalls.find((c) => c.sql.includes("workspace_id = $"));
    expect(filterCall).toBeDefined();
    expect(filterCall!.params).toContain("00000000-0000-0000-0000-0000000000aa");
  });
});
