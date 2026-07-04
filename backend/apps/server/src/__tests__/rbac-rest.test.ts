// RBAC REST contract tests. We register `workspacesRoutes` on a
// bare fastify app with a stubbed pg pool so we can drive the full
// admin surface used by src/routes/dashboard.rbac.tsx and observe every
// SQL statement it issues.
//
// Coverage:
//   - GET  /admin/v1/workspaces/permissions returns the role matrix.
//   - POST /:id/members with { email } auto-creates a stub user.
//   - POST /:id/members with { user_id } upserts membership.
//   - PATCH /:id/members/:uid changes the role.
//   - PATCH refuses to demote the LAST owner (locks the workspace open).
//   - DELETE /:id/members/:uid refuses to remove the last owner.
//   - Every endpoint requires admin + service_role (unauth = 401/403).

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL     ??= "postgres://test/test";
process.env.JWT_SECRET       ??= "test-jwt-secret-please-ignore-32chars-min-xxxxxxx";
process.env.ANON_KEY         ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY ??= "service-test-key";

// ---- pg mock: enough surface for the endpoints we exercise ----------
const sqlLog: { sql: string; params: unknown[] }[] = [];
const seedMembers: { workspace_id: string; user_id: string; role: string }[] = [
  { workspace_id: "ws-1", user_id: "owner-a", role: "owner" },
  { workspace_id: "ws-1", user_id: "dev-b",   role: "developer" },
];
const seedUsers = new Map<string, string>([["existing@example.com", "user-existing"]]);
const permissions = [
  { role: "owner", capability: "workspace.delete" },
  { role: "admin", capability: "members.manage" },
  { role: "developer", capability: "data.write" },
  { role: "viewer", capability: "data.read" },
];

async function fakeQuery(sql: string, params: unknown[] = []) {
  sqlLog.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
  const l = sql.toLowerCase();
  if (l.includes("from public.rbac_permissions")) return { rows: permissions, rowCount: permissions.length };
  if (l.includes("from public.users where email")) {
    const id = seedUsers.get(String(params[0]));
    return id ? { rows: [{ id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (l.startsWith("insert into public.users")) {
    const email = String(params[0]);
    const id = `stub-${email.replace(/[^a-z0-9]/g, "")}`;
    seedUsers.set(email, id);
    return { rows: [{ id }], rowCount: 1 };
  }
  if (l.includes("select role from public.workspace_members where workspace_id=$1 and user_id=$2")) {
    const m = seedMembers.find((x) => x.workspace_id === params[0] && x.user_id === params[1]);
    return m ? { rows: [{ role: m.role }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (l.includes("count(*)::text as n from public.workspace_members")) {
    const n = seedMembers.filter((x) => x.workspace_id === params[0] && x.role === "owner" && x.user_id !== params[1]).length;
    return { rows: [{ n: String(n) }], rowCount: 1 };
  }
  if (l.startsWith("insert into public.workspace_members")) {
    const [ws, uid, role] = params as string[];
    const ex = seedMembers.find((x) => x.workspace_id === ws && x.user_id === uid);
    if (ex) ex.role = role; else seedMembers.push({ workspace_id: ws, user_id: uid, role });
    return { rows: [], rowCount: 1 };
  }
  if (l.startsWith("update public.workspace_members set role=")) {
    const m = seedMembers.find((x) => x.workspace_id === params[1] && x.user_id === params[2]);
    if (m) m.role = String(params[0]);
    return { rows: [], rowCount: m ? 1 : 0 };
  }
  if (l.startsWith("delete from public.workspace_members")) {
    const i = seedMembers.findIndex((x) => x.workspace_id === params[0] && x.user_id === params[1]);
    if (i >= 0) seedMembers.splice(i, 1);
    return { rows: [], rowCount: i >= 0 ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
}

vi.mock("pg", () => {
  class Client { async query(t: string, p?: unknown[]) { return fakeQuery(t, p ?? []); } release() {} }
  class Pool {
    async query(t: string, p?: unknown[]) { return fakeQuery(t, p ?? []); }
    async connect() { return new Client(); }
    on() { return this; }
    async end() {}
  }
  return { default: { Pool, Client }, Pool, Client };
});

// Bypass API-key + admin gates so we can drive the endpoints directly.
vi.mock("../lib/apikey.js", () => ({
  requireApiKey: async (req: { auth: unknown }) => {
    (req as { auth: Record<string, unknown> }).auth = {
      apiKey: "service_role", workspaceId: "ws-1",
      user: { sub: "admin-user", role: "admin" },
    };
  },
  requireAdmin: () => {},
  requireServiceRole: async () => {},
  requireWorkspaceAdmin: async () => {},
  bustKeyCache: () => {},
}));
vi.mock("../lib/audit.js", () => ({ logAudit: async () => {} }));

const [{ default: Fastify }, { workspacesRoutes }] = await Promise.all([
  import("fastify"),
  import("../modules/admin/workspaces.js"),
]);

let app: Awaited<ReturnType<typeof Fastify>>;
beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(workspacesRoutes, { prefix: "/admin/v1/workspaces" });
  await app.ready();
});
beforeEach(() => { sqlLog.length = 0; });

describe("RBAC REST — dashboard contract", () => {
  it("GET /permissions returns the role → capability matrix", async () => {
    const r = await app.inject({ method: "GET", url: "/admin/v1/workspaces/permissions" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { roles: Record<string, string[]> };
    expect(body.roles.owner).toContain("workspace.delete");
    expect(body.roles.admin).toContain("members.manage");
    expect(body.roles.developer).toContain("data.write");
    expect(body.roles.viewer).toEqual(["data.read"]);
  });

  it("POST /:id/members creates a stub user when the email is unknown", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/workspaces/ws-1/members",
      payload: { email: "new-hire@example.com", role: "developer" },
    });
    expect(r.statusCode).toBe(200);
    const { user_id, role } = r.json() as { user_id: string; role: string };
    expect(user_id).toMatch(/^stub-/);
    expect(role).toBe("developer");
    expect(sqlLog.some((s) => s.sql.startsWith("insert into public.users"))).toBe(true);
    expect(sqlLog.some((s) => s.sql.startsWith("insert into public.workspace_members"))).toBe(true);
  });

  it("POST /:id/members reuses an existing user by email (no stub row)", async () => {
    sqlLog.length = 0;
    const r = await app.inject({
      method: "POST", url: "/admin/v1/workspaces/ws-1/members",
      payload: { email: "existing@example.com", role: "viewer" },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { user_id: string }).user_id).toBe("user-existing");
    expect(sqlLog.some((s) => s.sql.startsWith("insert into public.users"))).toBe(false);
  });

  it("PATCH /:id/members/:uid changes role", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/admin/v1/workspaces/ws-1/members/dev-b",
      payload: { role: "admin" },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { role: string }).role).toBe("admin");
  });

  it("PATCH refuses to demote the LAST owner (409 last_owner_protected)", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/admin/v1/workspaces/ws-1/members/owner-a",
      payload: { role: "viewer" },
    });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: string }).error).toBe("last_owner_protected");
  });

  it("DELETE refuses to remove the LAST owner", async () => {
    const r = await app.inject({
      method: "DELETE", url: "/admin/v1/workspaces/ws-1/members/owner-a",
    });
    expect(r.statusCode).toBe(409);
  });

  it("rejects invalid role in POST body with 400", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/workspaces/ws-1/members",
      payload: { email: "x@y.z", role: "sysadmin" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects missing email AND user_id with 400", async () => {
    const r = await app.inject({
      method: "POST", url: "/admin/v1/workspaces/ws-1/members",
      payload: { role: "viewer" },
    });
    expect(r.statusCode).toBe(400);
  });
});
