import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy path — canonical route is /dashboard/backups.
// Redirect keeps old bookmarks/links working.
export const Route = createFileRoute("/dashboard/pluto-backups")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/backups" });
  },
});
