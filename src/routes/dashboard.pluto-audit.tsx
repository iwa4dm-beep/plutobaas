import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy path — canonical route is /dashboard/audit.
// Redirect keeps old bookmarks/links working.
export const Route = createFileRoute("/dashboard/pluto-audit")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/audit" });
  },
});
