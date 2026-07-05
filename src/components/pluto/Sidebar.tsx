import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Archive, Building2, Cloud, Database, Files, Gauge, GitBranch, Gauge as GaugeAlt, Globe, HeartPulse, KeyRound, LineChart, LogOut, Package, Radio, Rocket, ScrollText, Search, Server, Settings, Shield, ShieldAlert, ShieldCheck, Sparkles, Terminal, Users, Waves, Zap } from "lucide-react";
import { useAuth } from "@/lib/pluto/auth-context";
import { WorkspaceSwitcher } from "@/components/pluto/WorkspaceSwitcher";

const items = [
  { to: "/dashboard", label: "Overview", icon: Gauge },
  { to: "/dashboard/pluto-admin", label: "Pluto Admin", icon: Server },
  { to: "/dashboard/pluto-functions", label: "Pluto Functions", icon: Rocket },
  { to: "/dashboard/projects", label: "Projects & Keys", icon: KeyRound },
  { to: "/dashboard/workspaces", label: "Workspaces", icon: Building2 },
  { to: "/dashboard/api", label: "REST endpoints", icon: Radio },
  { to: "/dashboard/cors", label: "CORS whitelist", icon: Globe },
  { to: "/dashboard/database", label: "Database", icon: Database },
  { to: "/dashboard/sql", label: "SQL runner", icon: Terminal },
  { to: "/dashboard/migrations", label: "Migrations", icon: GitBranch },
  { to: "/dashboard/users", label: "Auth & Users", icon: Users },
  { to: "/dashboard/mfa", label: "MFA & SSO", icon: Shield },
  { to: "/dashboard/ai", label: "AI & Vector", icon: Sparkles },
  { to: "/dashboard/storage", label: "Storage", icon: Files },
  { to: "/dashboard/jobs", label: "Jobs & pool user", icon: ShieldCheck },
  { to: "/dashboard/audit", label: "Audit trail", icon: ShieldAlert },
  { to: "/dashboard/audit-log", label: "Audit log", icon: ShieldAlert },
  { to: "/dashboard/logs", label: "Logs", icon: ScrollText },
  { to: "/dashboard/verify", label: "Live checklist", icon: Activity },
  { to: "/dashboard/integrations", label: "Integration health", icon: HeartPulse },
  { to: "/dashboard/scaling", label: "Scaling & queues", icon: Waves },
  { to: "/dashboard/observability", label: "Observability", icon: LineChart },
  { to: "/dashboard/devex", label: "DevEx & webhooks", icon: Package },
  { to: "/dashboard/enterprise", label: "Enterprise", icon: Globe },
  { to: "/dashboard/branching", label: "Branching & Studio", icon: GitBranch },
  { to: "/dashboard/usage", label: "Usage & Quotas", icon: GaugeAlt },
  { to: "/dashboard/realtime", label: "Realtime channels", icon: Radio },
  { to: "/dashboard/vector", label: "Vector search", icon: Search },
  { to: "/dashboard/functions", label: "Edge Functions", icon: Cloud },
  { to: "/dashboard/backups", label: "Backups", icon: Archive },
  { to: "/dashboard/logs-explorer", label: "Logs Explorer", icon: Search },
  { to: "/dashboard/tokens", label: "API Tokens", icon: KeyRound },
  { to: "/dashboard/sdk-demo", label: "SDK Demo", icon: Zap },
  { to: "/dashboard/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { session, signOut } = useAuth();

  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 px-5 py-5 border-b border-border">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Zap className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">Pluto BaaS</div>
          <div className="text-[11px] text-muted-foreground">Admin Console</div>
        </div>
      </div>

      <WorkspaceSwitcher />

      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {items.map(({ to, label, icon: Icon }) => {
          const active = pathname === to || (to !== "/dashboard" && pathname.startsWith(to));
          return (
            <Link
              key={to}
              to={to}
              className={
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors " +
                (active
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <div className="px-2 pb-2 text-xs text-muted-foreground truncate">
          {session?.user.email ?? "—"}
        </div>
        <button
          onClick={() => signOut()}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
