import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy path — canonical route is /dashboard/functions.
// Redirect keeps old bookmarks/links working.
export const Route = createFileRoute("/dashboard/pluto-functions")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/functions" });
  },
});
