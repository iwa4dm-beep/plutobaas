import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy alias — the Auto-Connect Studio page moved under the dashboard
// layout so it shares the sidebar. Anyone hitting /auto-connect directly
// (bookmarks, older links, docs) is forwarded to /dashboard/auto-connect,
// which mounts the sidebar and highlights the Getting Started item.
export const Route = createFileRoute("/auto-connect")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/auto-connect", replace: true });
  },
});
