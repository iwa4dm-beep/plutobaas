import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Sidebar } from "@/components/pluto/Sidebar";
import { CommandPalette } from "@/components/pluto/CommandPalette";
import { useAuth } from "@/lib/pluto/auth-context";
import { WorkspaceProvider } from "@/lib/pluto/workspace-context";


export const Route = createFileRoute("/dashboard")({
  ssr: false,
  component: DashboardLayout,
});

function DashboardLayout() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", replace: true });
  }, [loading, session, navigate]);

  if (loading || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <WorkspaceProvider>
      <div className="min-h-screen flex bg-background text-foreground">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <div className="max-w-6xl mx-auto px-6 py-8">
            <Outlet />
          </div>
        </main>
        <CommandPalette />
      </div>
    </WorkspaceProvider>

  );
}
