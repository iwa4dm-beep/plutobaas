import { describe, expect, it } from "vitest";
import {
  diagnosePermission,
  hasTracePermission,
  PERMISSION_REQUIREMENTS,
} from "./TraceAccessGate";

/**
 * Session shape mirrors what `liveSessionToPluto` in auth-context.tsx
 * builds, so the tests double as a contract check between the auth
 * adapter and the RBAC gate.
 */
function makeSession(user: {
  email?: string;
  role?: string;
  is_superadmin?: boolean;
  app_metadata?: Record<string, unknown>;
}) {
  return {
    access_token: "t",
    refresh_token: "r",
    expires_at: Date.now() / 1000 + 3600,
    user: { id: "u1", email: user.email ?? "u@x.io", created_at: "", email_verified: true, ...user },
  };
}

describe("TraceAccessGate — role propagation", () => {
  it("denies unauthenticated sessions on both permissions", () => {
    expect(hasTracePermission(null, "view")).toBe(false);
    expect(hasTracePermission(null, "manage")).toBe(false);
    expect(hasTracePermission(undefined, "view")).toBe(false);
  });

  it("denies plain user role", () => {
    const s = makeSession({ role: "user" });
    expect(hasTracePermission(s, "view")).toBe(false);
    expect(hasTracePermission(s, "manage")).toBe(false);
  });

  it("admin can view but not manage", () => {
    const s = makeSession({ role: "admin" });
    expect(hasTracePermission(s, "view")).toBe(true);
    expect(hasTracePermission(s, "manage")).toBe(false);
  });

  it("owner can view and manage", () => {
    const s = makeSession({ role: "owner" });
    expect(hasTracePermission(s, "view")).toBe(true);
    expect(hasTracePermission(s, "manage")).toBe(true);
  });

  it("service_role can view and manage", () => {
    const s = makeSession({ role: "service_role" });
    expect(hasTracePermission(s, "view")).toBe(true);
    expect(hasTracePermission(s, "manage")).toBe(true);
  });

  it("is_superadmin overrides any role", () => {
    const admin = makeSession({ role: "admin", is_superadmin: true });
    expect(hasTracePermission(admin, "view")).toBe(true);
    expect(hasTracePermission(admin, "manage")).toBe(true);

    const user = makeSession({ role: "user", is_superadmin: true });
    expect(hasTracePermission(user, "view")).toBe(true);
    expect(hasTracePermission(user, "manage")).toBe(true);
  });

  it("app_metadata.is_superadmin is honored (Supabase-style JWT)", () => {
    const s = makeSession({ role: "user", app_metadata: { is_superadmin: true } });
    expect(hasTracePermission(s, "manage")).toBe(true);
  });

  it("app_metadata.superadmin (legacy key) is honored", () => {
    const s = makeSession({ role: "user", app_metadata: { superadmin: true } });
    expect(hasTracePermission(s, "view")).toBe(true);
  });
});

describe("diagnosePermission — structured explanations", () => {
  it("reports role match reason", () => {
    const d = diagnosePermission(makeSession({ role: "admin" }), "view");
    expect(d.allowed).toBe(true);
    expect(d.matched).toBe("role=admin");
    expect(d.reason).toContain('role "admin"');
  });

  it("reports superadmin match reason", () => {
    const d = diagnosePermission(makeSession({ role: "user", is_superadmin: true }), "manage");
    expect(d.allowed).toBe(true);
    expect(d.matched).toBe("is_superadmin");
  });

  it("reports denial with required list", () => {
    const d = diagnosePermission(makeSession({ role: "admin" }), "manage");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("admin");
    expect(d.requirement.roles).toEqual(PERMISSION_REQUIREMENTS.manage.roles);
  });

  it("collects all raw role and superadmin sources", () => {
    const d = diagnosePermission(makeSession({ role: "admin", is_superadmin: false }), "view");
    expect(d.rawRoleSources.map((r) => r.location)).toContain("session.user.role");
    expect(d.superadminSources.map((r) => r.location)).toContain(
      "session.user.app_metadata.is_superadmin",
    );
  });

  it("regression: admin+is_superadmin=true is granted manage (was previously stripped)", () => {
    // Historical bug: auth-context filtered is_superadmin out of the
    // adapted session. This test locks the fix in place.
    const d = diagnosePermission(
      makeSession({ role: "admin", is_superadmin: true, email: "admin@x.io" }),
      "manage",
    );
    expect(d.allowed).toBe(true);
    expect(d.isSuperadmin).toBe(true);
  });
});
