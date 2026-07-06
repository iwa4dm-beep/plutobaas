import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy path — canonical route is /dashboard/ai.
// Redirect keeps old bookmarks/links working.
export const Route = createFileRoute("/dashboard/pluto-ai")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/ai" });
  },
});
