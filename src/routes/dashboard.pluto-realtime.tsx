import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy path — canonical route is /dashboard/realtime.
// Redirect keeps old bookmarks/links working.
export const Route = createFileRoute("/dashboard/pluto-realtime")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/realtime" });
  },
});
