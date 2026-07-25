import { describe, expect, it } from "vitest";
import { diagnosePermission, hasTracePermission } from "@/components/pluto/TraceAccessGate";

/**
 * Integration test for the auth-context session adapter.
 *
 * `liveSessionToPluto` (in ./auth-context.tsx) rebuilds the session
 * object from the raw backend response. A previous bug silently dropped
 * `is_superadmin`, which broke the manage-permission gate for
 * superadmins signed in as role=admin. These tests reproduce the adapter
 * inline so we can assert propagation without a React runtime, and
 * simultaneously verify TraceAccessGate reads the same fields the
 * adapter writes — locking the two contracts together.
 */

type LiveUser = {
  id: string;
  email: string;
  role?: string;
  is_superadmin?: boolean;
  created_at?: string;
  email_verified?: boolean;
  email_confirmed_at?: string | null;
};

// Kept in sync with src/lib/pluto/auth-context.tsx :: liveSessionToPluto.
function adapt(u: LiveUser) {
  return {
    access_token: "t",
    refresh_token: "r",
    expires_at: Date.now() / 1000 + 3600,
    user: {
      id: u.id,
      email: u.email,
      role: u.is_superadmin || u.role === "admin" ? "admin" : "user",
      created_at: u.created_at ?? "",
      email_verified: u.email_verified ?? Boolean(u.email_confirmed_at),
      is_superadmin: Boolean(u.is_superadmin),
    },
  };
}

describe("liveSessionToPluto adapter → TraceAccessGate", () => {
  it("propagates is_superadmin for admin@ users", () => {
    const s = adapt({
      id: "u1",
      email: "admin@timescard.cloud",
      role: "admin",
      is_superadmin: true,
    });
    expect(s.user.is_superadmin).toBe(true);
    expect(hasTracePermission(s, "manage")).toBe(true);
    expect(hasTracePermission(s, "view")).toBe(true);
  });

  it("keeps a plain admin denied for manage but allowed for view", () => {
    const s = adapt({ id: "u2", email: "adm@x.io", role: "admin" });
    expect(s.user.is_superadmin).toBe(false);
    expect(hasTracePermission(s, "view")).toBe(true);
    expect(hasTracePermission(s, "manage")).toBe(false);
    const d = diagnosePermission(s, "manage");
    expect(d.reason).toContain("admin");
  });

  it("regular users are denied both gates", () => {
    const s = adapt({ id: "u3", email: "u@x.io", role: "user" });
    expect(hasTracePermission(s, "view")).toBe(false);
    expect(hasTracePermission(s, "manage")).toBe(false);
  });

  it("superadmin without an admin role still passes both gates", () => {
    const s = adapt({ id: "u4", email: "root@x.io", is_superadmin: true });
    // adapter promotes is_superadmin → role=admin for downstream API
    // consumers, and the gate still recognizes the superadmin flag.
    expect(s.user.role).toBe("admin");
    expect(s.user.is_superadmin).toBe(true);
    expect(hasTracePermission(s, "manage")).toBe(true);
  });
});
