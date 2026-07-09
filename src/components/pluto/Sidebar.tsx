import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity, Archive, Boxes, Building2, ChevronDown, Cloud, Database, Files,
  Gauge, GitBranch, Globe, HeartPulse, KeyRound, LineChart,
  LockKeyhole, LogOut, Package, Radio, ScrollText, Search, Server,
  Settings, Shield, ShieldAlert, ShieldCheck, ShoppingBag, Sparkles, Table2,
  Terminal, Users, Waves, X, Zap,
} from "lucide-react";
import { useAuth } from "@/lib/pluto/auth-context";
import { WorkspaceSwitcher } from "@/components/pluto/WorkspaceSwitcher";

type Item = { to: string; label: string; icon: typeof Gauge };
type Group = { label: string; items: Item[] };

const groups: Group[] = [
  {
    label: "Overview",
    items: [
      { to: "/dashboard", label: "Overview", icon: Gauge },
      { to: "/dashboard/pluto-admin", label: "Pluto Admin", icon: Server },
      { to: "/dashboard/verify", label: "Live checklist", icon: Activity },
      { to: "/dashboard/integrations", label: "Integration health", icon: HeartPulse },
    ],
  },
  {
    label: "Data",
    items: [
      { to: "/dashboard/database", label: "Database", icon: Database },
      { to: "/dashboard/database-import", label: "Database Import & Connect", icon: Database },
      { to: "/dashboard/sql", label: "SQL runner", icon: Terminal },
      { to: "/dashboard/pluto-schema", label: "Schema", icon: Boxes },
      { to: "/dashboard/pluto-studio", label: "Data Studio", icon: Table2 },
      { to: "/dashboard/migrations", label: "Migrations", icon: GitBranch },
      { to: "/dashboard/graphql", label: "GraphQL", icon: Sparkles },
      { to: "/dashboard/api", label: "REST endpoints", icon: Radio },
    ],
  },

  {
    label: "Auth & Users",
    items: [
      { to: "/dashboard/users", label: "Users", icon: Users },
      { to: "/dashboard/pluto-auth-advanced", label: "OAuth / MFA / SSO", icon: Shield },
      { to: "/dashboard/pluto-orgs", label: "Orgs & Teams", icon: Building2 },
      { to: "/dashboard/rbac", label: "RBAC", icon: ShieldCheck },
      { to: "/dashboard/tokens", label: "API Tokens", icon: KeyRound },
    ],
  },
  {
    label: "Storage & Files",
    items: [
      { to: "/dashboard/storage", label: "Storage", icon: Files },
      { to: "/dashboard/pluto-storage-plus", label: "Storage (advanced)", icon: Files },
    ],
  },
  {
    label: "Realtime & Functions",
    items: [
      { to: "/dashboard/realtime", label: "Realtime channels", icon: Radio },
      { to: "/dashboard/functions", label: "Edge Functions", icon: Cloud },
      { to: "/dashboard/pluto-functions-plus", label: "Cron & Logs", icon: Cloud },
      { to: "/dashboard/pluto-queues", label: "Queues & Jobs", icon: Waves },
      { to: "/dashboard/pluto-webhooks", label: "Webhooks", icon: Package },
    ],
  },
  {
    label: "AI & Search",
    items: [
      { to: "/dashboard/ai", label: "AI & Vector", icon: Sparkles },
      { to: "/dashboard/pluto-ai", label: "AI Gateway", icon: Sparkles },
      { to: "/dashboard/pluto-search", label: "Search & Vector", icon: Search },
    ],
  },
  {
    label: "Ops & Observability",
    items: [
      { to: "/dashboard/observability", label: "Observability", icon: LineChart },
      { to: "/dashboard/logs", label: "Logs", icon: ScrollText },
      { to: "/dashboard/logs-explorer", label: "Logs Explorer", icon: Search },
      { to: "/dashboard/audit", label: "Audit trail", icon: ShieldAlert },
      { to: "/dashboard/audit-log", label: "Audit log (raw)", icon: ShieldAlert },
      { to: "/dashboard/scaling", label: "Scaling", icon: Waves },
      { to: "/dashboard/usage", label: "Usage & Quotas", icon: Gauge },
      { to: "/dashboard/pluto-billing", label: "Billing & Alerts", icon: Gauge },
    ],
  },
  {
    label: "Platform",
    items: [
      { to: "/dashboard/projects", label: "Projects & Keys", icon: KeyRound },
      { to: "/dashboard/workspaces", label: "Workspaces", icon: Building2 },
      { to: "/dashboard/cors", label: "CORS whitelist", icon: Globe },
      { to: "/dashboard/custom-domains", label: "Custom domains", icon: Globe },
      { to: "/dashboard/backups", label: "Backups", icon: Archive },
      { to: "/dashboard/branching", label: "Branching & Studio", icon: GitBranch },
      { to: "/dashboard/pluto-branches", label: "Branches (advanced)", icon: GitBranch },
      { to: "/dashboard/pluto-replicas", label: "Read Replicas", icon: Globe },
      { to: "/dashboard/pluto-compliance", label: "Compliance (GDPR)", icon: ShieldCheck },
      { to: "/dashboard/pluto-vault", label: "Vault & Secrets", icon: LockKeyhole },
      { to: "/dashboard/enterprise", label: "Enterprise", icon: Globe },
      { to: "/dashboard/pluto-marketplace", label: "Marketplace", icon: ShoppingBag },
    ],
  },
  {
    label: "Developer",
    items: [
      { to: "/dashboard/pluto-sdk", label: "CLI & SDK", icon: Terminal },
      { to: "/dashboard/sdk-demo", label: "SDK Demo", icon: Zap },
      { to: "/dashboard/devex", label: "DevEx", icon: Package },
      { to: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
];

/** Sidebar renders as a fixed left rail on desktop, a slide-in drawer on mobile.
 *  `mobileOpen` / `onCloseMobile` are supplied by the dashboard layout header. */
export function Sidebar({
  mobileOpen = false,
  onCloseMobile,
}: {
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { session, signOut } = useAuth();

  const initialOpen = new Set<string>();
  for (const g of groups) {
    if (g.items.some((i) => pathname === i.to || (i.to !== "/dashboard" && pathname.startsWith(i.to)))) {
      initialOpen.add(g.label);
    }
  }
  if (initialOpen.size === 0) initialOpen.add("Overview");
  const [open, setOpen] = useState<Set<string>>(initialOpen);

  // Close mobile drawer on route change.
  useEffect(() => { onCloseMobile?.(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pathname]);

  const toggle = (label: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const body = (
    <>
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-sidebar-border">
        <div className="relative flex h-9 w-9 items-center justify-center rounded-xl gradient-primary text-primary-foreground shadow-elegant animate-glow-pulse">
          <Zap className="h-4 w-4" strokeWidth={2.5} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-tight font-display truncate">Pluto BaaS</div>
          <div className="text-[11px] text-muted-foreground truncate">Admin Console</div>
        </div>
        {onCloseMobile && (
          <button
            onClick={onCloseMobile}
            className="md:hidden ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <WorkspaceSwitcher />

      <nav className="flex-1 px-3 py-3 space-y-1.5 overflow-y-auto" aria-label="Primary">
        {groups.map((g) => {
          const isOpen = open.has(g.label);
          return (
            <div key={g.label}>
              <button
                type="button"
                onClick={() => toggle(g.label)}
                aria-expanded={isOpen}
                aria-controls={`nav-group-${g.label.replace(/\s+/g, "-").toLowerCase()}`}
                className="flex w-full items-center justify-between rounded-md px-3 py-2 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80 hover:text-foreground transition-colors"
              >
                <span>{g.label}</span>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-300 ${isOpen ? "" : "-rotate-90"}`} aria-hidden="true" />
              </button>
              {isOpen && (
                <div
                  id={`nav-group-${g.label.replace(/\s+/g, "-").toLowerCase()}`}
                  className="mt-1 space-y-1 animate-fade-in-up"
                >
                  {g.items.map(({ to, label, icon: Icon }) => {
                    const active =
                      pathname === to || (to !== "/dashboard" && pathname.startsWith(to));
                    return (
                      <Link
                        key={to}
                        to={to}
                        aria-current={active ? "page" : undefined}
                        className={
                          "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] transition-all duration-200 " +
                          (active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                            : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground hover:translate-x-0.5")
                        }
                      >
                        {active && (
                          <span aria-hidden="true" className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-0.5 rounded-r gradient-primary" />
                        )}
                        <Icon aria-hidden="true" className={`h-[18px] w-[18px] shrink-0 transition-colors ${active ? "text-primary" : "text-muted-foreground group-hover:text-primary/80"}`} />
                        <span className="truncate">{label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>


      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2 px-2 pb-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground uppercase">
            {(session?.user?.email ?? "?").slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-foreground truncate">{session?.user?.email ?? "—"}</div>
            <div className="text-[10px] text-muted-foreground truncate">Signed in</div>
          </div>
        </div>
        <button
          onClick={() => signOut()}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside aria-label="Main navigation" className="hidden md:flex w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar/95 backdrop-blur-xl">
        {body}
      </aside>

      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-40 md:hidden transition-opacity duration-300 ${mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onCloseMobile}
        aria-hidden={!mobileOpen}
      >

        <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" />
        <aside
          onClick={(e) => e.stopPropagation()}
          className={`absolute left-0 top-0 h-full w-72 flex flex-col bg-sidebar border-r border-sidebar-border shadow-elegant transition-transform duration-300 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
        >
          {body}
        </aside>
      </div>
    </>
  );
}
