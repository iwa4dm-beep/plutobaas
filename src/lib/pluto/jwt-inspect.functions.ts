// JWT claims inspector — the frontend can decode the JWT locally (unverified
// header/payload), but to know how the *backend* interprets the token we
// echo it back through a server fn that runs under requirePlutoAdmin. That
// verifies the signature via /auth/v1/user and returns the effective role
// the API would apply to a PostgREST/dbio call.

import { createServerFn } from "@tanstack/react-start";
import { requirePlutoAdmin } from "./admin-middleware";

export type BackendClaimsView = {
  userId: string;
  email: string;
  role: "admin" | "user";
  effectivePostgresRole: "authenticated" | "service_role" | "anon";
  isSuperadmin: boolean;
  claimsSource: "auth.v1.user";
  verifiedAt: string;
};

export const whoAmIToBackend = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .handler(async ({ context }): Promise<BackendClaimsView> => {
    const admin = (context as { plutoAdmin?: { userId?: string; email?: string; role?: string; isSuperadmin?: boolean; is_superadmin?: boolean } }).plutoAdmin ?? {};
    const isSuper = Boolean(admin.isSuperadmin ?? admin.is_superadmin);
    // Backend treats verified admin tokens as PostgREST `authenticated` role
    // with is_superadmin claim controlling elevated ops; only true service
    // tokens map to service_role. Anon has no session.
    const effective = isSuper ? "service_role" : (admin.role === "admin" ? "authenticated" : "authenticated");
    return {
      userId: String(admin.userId ?? ""),
      email: String(admin.email ?? ""),
      role: (admin.role === "admin" ? "admin" : "user"),
      effectivePostgresRole: effective,
      isSuperadmin: isSuper,
      claimsSource: "auth.v1.user",
      verifiedAt: new Date().toISOString(),
    };
  });
