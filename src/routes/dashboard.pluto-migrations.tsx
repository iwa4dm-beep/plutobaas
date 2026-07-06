import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy path — canonical route is /dashboard/migrations.
// Redirect keeps old bookmarks/links working.
export const Route = createFileRoute("/dashboard/pluto-migrations")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/migrations" });
  },
});
