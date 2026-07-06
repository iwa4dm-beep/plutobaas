import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy path — canonical route is /dashboard/graphql.
// Redirect keeps old bookmarks/links working.
export const Route = createFileRoute("/dashboard/pluto-graphql")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard/graphql" });
  },
});
