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

/** Roles / flags allowed to satisfy each permission tier. */
export const PERMISSION_REQUIREMENTS: Record<TracePermission, {
  roles: readonly string[];
  requireSuperadmin: boolean;
  description: string;
}> = {
  view: {
    roles: ["admin", "owner", "service_role"],
    requireSuperadmin: false,
    description: "workspace admin/owner (or service_role / superadmin) to view traces",
  },
  manage: {
    roles: ["owner", "service_role"],
    requireSuperadmin: false,
    description:
      "workspace owner (or service_role / superadmin) to manage PII rules and alert webhooks",
  },
};

/** Structured diagnostic summary — used by the debug page and error card. */
export type PermissionDiagnostic = {
  email: string | null;
  role: string;
  isSuperadmin: boolean;
  rawRoleSources: { location: string; value: unknown }[];
  superadminSources: { location: string; value: unknown }[];
  permission: TracePermission;
  allowed: boolean;
  reason: string;
  matched: string | null;
  requirement: (typeof PERMISSION_REQUIREMENTS)[TracePermission];
};

export function getRole(session: unknown): string {
  if (!session || typeof session !== "object") return "";
  const s = session as { user?: { role?: string }; role?: string };
  return String(s.user?.role ?? s.role ?? "").toLowerCase();
}

export function isSuperadmin(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const s = session as {
    user?: {
      is_superadmin?: boolean;
      app_metadata?: { is_superadmin?: boolean; superadmin?: boolean };
    };
  };
  return Boolean(
    s.user?.is_superadmin ||
      s.user?.app_metadata?.is_superadmin ||
      s.user?.app_metadata?.superadmin,
  );
}

export function hasTracePermission(session: unknown, perm: TracePermission): boolean {
  return diagnosePermission(session, perm).allowed;
}

/**
 * Return a full diagnostic breakdown of *why* a permission was granted or
 * denied. Powers both the improved error card and the RBAC debug page so
 * they always agree on the reason.
 */
export function diagnosePermission(
  session: unknown,
  perm: TracePermission,
): PermissionDiagnostic {
  const requirement = PERMISSION_REQUIREMENTS[perm];
  const s = (session ?? {}) as {
    user?: {
      email?: string;
      role?: string;
      is_superadmin?: boolean;
      app_metadata?: { is_superadmin?: boolean; superadmin?: boolean };
    };
    role?: string;
  };

  const rawRoleSources = [
    { location: "session.user.role", value: s.user?.role },
    { location: "session.role", value: s.role },
  ];
  const superadminSources = [
    { location: "session.user.is_superadmin", value: s.user?.is_superadmin },
    {
      location: "session.user.app_metadata.is_superadmin",
      value: s.user?.app_metadata?.is_superadmin,
    },
    {
      location: "session.user.app_metadata.superadmin",
      value: s.user?.app_metadata?.superadmin,
    },
  ];

  const role = getRole(session);
  const zuper = isSuperadmin(session);
  const email = s.user?.email ?? null;

  let allowed = false;
  let matched: string | null = null;
  let reason = "";

  if (zuper) {
    allowed = true;
    matched = "is_superadmin";
    reason = "Granted via is_superadmin flag";
  } else if (requirement.roles.includes(role)) {
    allowed = true;
    matched = `role=${role}`;
    reason = `Granted via role "${role}"`;
  } else {
    reason = role
      ? `Role "${role}" is not in the allowed list (${requirement.roles.join(", ")}) and is_superadmin is not set.`
      : `No role detected on session and is_superadmin is not set.`;
  }

  return {
    email,
    role,
    isSuperadmin: zuper,
    rawRoleSources,
    superadminSources,
    permission: perm,
    allowed,
    reason,
    matched,
    requirement,
  };
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

  const diag = diagnosePermission(session, permission);
  if (!diag.allowed) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-8">
          <div className="text-center">
            <ShieldAlert className="mx-auto h-8 w-8 text-rose-300" />
            <h1 className="mt-3 text-2xl font-semibold text-rose-200">
              {permission === "manage" ? "Owner access required" : "Admin access required"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Signed in as{" "}
              <span className="font-mono">{diag.email ?? "unknown"}</span>. You
              need to be a {diag.requirement.description}.
            </p>
          </div>

          <div className="mt-6 rounded-lg border border-border/60 bg-background/40 p-4 text-left text-xs">
            <div className="mb-2 font-semibold text-foreground">Diagnostic</div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono">
              <dt className="text-muted-foreground">detected role</dt>
              <dd>{diag.role || <span className="text-muted-foreground">(none)</span>}</dd>
              <dt className="text-muted-foreground">is_superadmin</dt>
              <dd>{diag.isSuperadmin ? "true" : "false"}</dd>
              <dt className="text-muted-foreground">required</dt>
              <dd>
                one of [{diag.requirement.roles.join(", ")}]{" "}
                <span className="text-muted-foreground">or</span> is_superadmin=true
              </dd>
              <dt className="text-muted-foreground">reason</dt>
              <dd>{diag.reason}</dd>
            </dl>
            <div className="mt-3 text-muted-foreground">
              Open{" "}
              <Link
                to="/dashboard/rbac-debug"
                className="underline hover:text-foreground"
              >
                RBAC debug
              </Link>{" "}
              for the full session dump and gate matrix.
            </div>
          </div>

          <p className="mt-4 text-center text-xs text-muted-foreground">
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
