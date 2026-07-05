import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/pluto/auth-context";

/**
 * Restricts children to signed-in users whose Pluto session role is `admin`
 * (or `owner` / `service_role`). Everyone else sees a friendly access-denied
 * card instead of the sensitive content.
 */
export function AdminGate({ children }: { children: ReactNode }) {
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
          <h1 className="text-2xl font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page is restricted to authorized administrators. Please sign in
            to continue.
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

  const role = String((session as { role?: string }).role ?? "").toLowerCase();
  const isAdmin = role === "admin" || role === "owner" || role === "service_role";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-8 text-center">
          <h1 className="text-2xl font-semibold text-rose-200">Admin access only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You are signed in as{" "}
            <span className="font-mono">{(session as { email?: string }).email ?? "unknown"}</span>{" "}
            with role <span className="font-mono">{role || "user"}</span>. This
            page shows sensitive backend URLs and health probe history, so it is
            limited to accounts with the <span className="font-mono">admin</span>{" "}
            role.
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Ask a workspace owner to grant you the admin role, then reload this
            page.
          </p>
          <Link
            to="/dashboard"
            className="mt-6 inline-flex items-center rounded-md border border-border/60 px-4 py-2 text-sm font-medium hover:bg-muted/40"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
