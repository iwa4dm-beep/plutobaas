import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ShieldAlert, Lock } from "lucide-react";
import { useAuth } from "@/lib/pluto/auth-context";

/**
 * Role-based access control for admin trace pages.
 *
 * Two permission levels:
 *  - "view"   → read traces + trends (admin, owner, service_role, superadmin)
 *  - "manage" → CRUD PII redaction rules & alert webhooks (owner,
 *               service_role, superadmin only)
 *
 * The backend enforces service_role/superadmin on the actual endpoints
 * (see routes/observability.ts). This gate is the friendly frontend
 * counterpart — it prevents non-permitted users from even loading the
 * page and gives a clear reason instead of surfacing a raw 403.
 */
export type TracePermission = "view" | "manage";

function getRole(session: unknown): string {
  if (!session || typeof session !== "object") return "";
  const s = session as { user?: { role?: string }; role?: string };
  return String(s.user?.role ?? s.role ?? "").toLowerCase();
}

function isSuperadmin(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const s = session as {
    user?: { is_superadmin?: boolean; app_metadata?: { is_superadmin?: boolean; superadmin?: boolean } };
  };
  return Boolean(
    s.user?.is_superadmin ||
      s.user?.app_metadata?.is_superadmin ||
      s.user?.app_metadata?.superadmin,
  );
}

export function hasTracePermission(session: unknown, perm: TracePermission): boolean {
  const role = getRole(session);
  const zuper = isSuperadmin(session);
  if (zuper || role === "service_role") return true;
  if (perm === "view") return role === "admin" || role === "owner";
  // manage
  return role === "owner";
}

export function TraceAccessGate({
  children,
  permission,
}: {
  children: ReactNode;
  permission: TracePermission;
}) {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-sm text-muted-foreground">
        Checking permissions…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="rounded-2xl border border-border/60 bg-card/60 p-8 text-center">
          <Lock className="mx-auto h-8 w-8 text-muted-foreground" />
          <h1 className="mt-3 text-2xl font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The trace viewer is limited to authorized operators. Please sign
            in to continue.
          </p>
          <Link
            to="/auth"
            className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (!hasTracePermission(session, permission)) {
    const role = getRole(session) || "user";
    const need =
      permission === "manage"
        ? "workspace owner (or service_role) to manage PII rules and alert webhooks"
        : "workspace admin/owner (or service_role) to view traces";
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-8 text-center">
          <ShieldAlert className="mx-auto h-8 w-8 text-rose-300" />
          <h1 className="mt-3 text-2xl font-semibold text-rose-200">
            {permission === "manage" ? "Owner access required" : "Admin access required"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Signed in as{" "}
            <span className="font-mono">{session.user?.email ?? "unknown"}</span>{" "}
            with role <span className="font-mono">{role}</span>. You need to be
            a {need}.
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Ask a workspace owner to grant the required role, then reload the page.
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <Link
              to="/dashboard"
              className="inline-flex items-center rounded-md border border-border/60 px-4 py-2 text-sm font-medium hover:bg-muted/40"
            >
              Back to dashboard
            </Link>
            {permission === "manage" && hasTracePermission(session, "view") && (
              <Link
                to="/dashboard/traces"
                className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                View traces
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * Non-blocking helper for inline UI (buttons, links). Returns true when the
 * current session may perform the action. Prefer this over duplicating the
 * role check logic across pages.
 */
export function useTracePermission(permission: TracePermission): boolean {
  const { session } = useAuth();
  return hasTracePermission(session, permission);
}
