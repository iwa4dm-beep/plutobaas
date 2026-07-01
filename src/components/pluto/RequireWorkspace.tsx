// Route guard for pages that require workspace membership.
//
// Non-members see an inline "not authorized" pane instead of the page
// contents. This is UX defense-in-depth — the server enforces the same
// rule (requireAdmin + workspace filter) but hiding pages the caller
// can't use avoids confusing 403 responses.

import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useWorkspace } from "@/lib/pluto/workspace-context";

export function RequireWorkspace({ children }: { children: ReactNode }) {
  const { active, isMember, loading } = useWorkspace();

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">Loading workspace…</div>;
  }
  if (!isMember(active.id)) {
    return (
      <div className="max-w-lg mx-auto mt-16 rounded-lg border border-amber-500/30 bg-amber-500/5 p-6 text-sm">
        <div className="flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-amber-400 mt-0.5" />
          <div>
            <div className="text-base font-semibold mb-1">Not a member of {active.name}</div>
            <p className="text-muted-foreground mb-3">
              This page is scoped to a workspace you don't belong to. Switch to a workspace where
              your account has membership, or ask an owner to invite you.
            </p>
            <Link to="/dashboard/workspaces" className="text-primary underline text-sm">
              Manage workspaces →
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
