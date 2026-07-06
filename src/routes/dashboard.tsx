import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Menu, Search } from "lucide-react";
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
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", replace: true });
  }, [loading, session, navigate]);

  if (loading || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary animate-glow-pulse" />
          Loading…
        </span>
      </div>
    );
  }

  return (
    <WorkspaceProvider>
      <div className="relative min-h-screen flex bg-background text-foreground">
        {/* Ambient mesh backdrop */}
        <div className="pointer-events-none fixed inset-0 -z-10 mesh-bg opacity-70" />

        <Sidebar mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />

        <main className="flex-1 flex flex-col min-w-0">
          {/* Top bar — mobile menu + search hint */}
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border/60 bg-background/70 px-4 sm:px-6 py-3 backdrop-blur-xl">
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-glow-pulse" />
              <span>Pluto BaaS</span>
              <span className="opacity-40">/</span>
              <span className="text-foreground/80">Admin Console</span>
            </div>
            <div className="ml-auto">
              <button
                onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
                className="group inline-flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground transition-all backdrop-blur"
              >
                <Search className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Quick jump</span>
                <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] font-mono">
                  ⌘K
                </kbd>
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-fade-in-up">
              <Outlet />
            </div>
          </div>
        </main>

        <CommandPalette />
      </div>
    </WorkspaceProvider>
  );
}
