import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity, Archive, Boxes, Building2, Cloud, Database, Files, Gauge, GitBranch,
  Globe, HeartPulse, History, KeyRound, LineChart, LockKeyhole, Package, Radio,
  Rocket, ScrollText, Search, Server, Settings, Shield, ShieldAlert, ShieldCheck,
  ShoppingBag, Sparkles, Table2, Terminal, Users, Waves, Zap, Home, LogOut,
} from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem,
  CommandList, CommandSeparator, CommandShortcut,
} from "@/components/ui/command";
import { useAuth } from "@/lib/pluto/auth-context";

type Entry = {
  group: string;
  label: string;
  to?: string;
  keywords?: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: "signout";
};

const entries: Entry[] = [
  // Overview
  { group: "Overview", label: "Dashboard home", to: "/dashboard", icon: Home, keywords: "overview index" },
  { group: "Overview", label: "Pluto Admin", to: "/dashboard/pluto-admin", icon: Server },
  { group: "Overview", label: "Live checklist", to: "/dashboard/verify", icon: Activity, keywords: "status verify" },
  { group: "Overview", label: "Integration health", to: "/dashboard/integrations", icon: HeartPulse },
  { group: "Overview", label: "Backend status", to: "/dashboard/backend-status", icon: Activity },

  // Data
  { group: "Data", label: "Database", to: "/dashboard/database", icon: Database },
  { group: "Data", label: "SQL runner", to: "/dashboard/sql", icon: Terminal, keywords: "query editor" },
  { group: "Data", label: "Schema", to: "/dashboard/pluto-schema", icon: Boxes },
  { group: "Data", label: "Data Studio", to: "/dashboard/pluto-studio", icon: Table2, keywords: "tables editor" },
  { group: "Data", label: "Migrations", to: "/dashboard/migrations", icon: GitBranch },
  { group: "Data", label: "Pluto Migrations", to: "/dashboard/pluto-migrations", icon: GitBranch },
  { group: "Data", label: "GraphQL", to: "/dashboard/pluto-graphql", icon: Sparkles },
  { group: "Data", label: "GraphQL (legacy)", to: "/dashboard/graphql", icon: Sparkles },
  { group: "Data", label: "REST endpoints", to: "/dashboard/api", icon: Radio, keywords: "rest openapi" },

  // Auth & users
  { group: "Auth & Users", label: "Users", to: "/dashboard/users", icon: Users },
  { group: "Auth & Users", label: "MFA & SSO", to: "/dashboard/mfa", icon: Shield },
  { group: "Auth & Users", label: "Auth advanced (OAuth / MFA / SSO)", to: "/dashboard/pluto-auth-advanced", icon: Shield },
  { group: "Auth & Users", label: "Orgs & Teams", to: "/dashboard/pluto-orgs", icon: Building2 },
  { group: "Auth & Users", label: "RBAC", to: "/dashboard/rbac", icon: ShieldCheck, keywords: "roles permissions" },
  { group: "Auth & Users", label: "API Tokens", to: "/dashboard/tokens", icon: KeyRound },

  // Storage
  { group: "Storage", label: "Storage", to: "/dashboard/storage", icon: Files },
  { group: "Storage", label: "Storage v2", to: "/dashboard/pluto-storage-plus", icon: Files },

  // Realtime & functions
  { group: "Realtime & Functions", label: "Realtime channels", to: "/dashboard/realtime", icon: Radio },
  { group: "Realtime & Functions", label: "Realtime & Presence", to: "/dashboard/pluto-realtime", icon: Radio },
  { group: "Realtime & Functions", label: "Edge Functions", to: "/dashboard/functions", icon: Cloud },
  { group: "Realtime & Functions", label: "Pluto Functions", to: "/dashboard/pluto-functions", icon: Rocket },
  { group: "Realtime & Functions", label: "Cron & Logs", to: "/dashboard/pluto-functions-plus", icon: Cloud },
  { group: "Realtime & Functions", label: "Jobs", to: "/dashboard/jobs", icon: ShieldCheck },
  { group: "Realtime & Functions", label: "Queues & Jobs", to: "/dashboard/pluto-queues", icon: Waves },
  { group: "Realtime & Functions", label: "Webhooks", to: "/dashboard/pluto-webhooks", icon: Package },

  // AI & Search
  { group: "AI & Search", label: "AI & Vector", to: "/dashboard/ai", icon: Sparkles },
  { group: "AI & Search", label: "AI Gateway", to: "/dashboard/pluto-ai", icon: Sparkles },
  { group: "AI & Search", label: "Vector search", to: "/dashboard/vector", icon: Search },
  { group: "AI & Search", label: "Search & Vector", to: "/dashboard/pluto-search", icon: Search },

  // Ops
  { group: "Ops & Observability", label: "Observability", to: "/dashboard/observability", icon: LineChart },
  { group: "Ops & Observability", label: "Logs", to: "/dashboard/logs", icon: ScrollText },
  { group: "Ops & Observability", label: "Logs Explorer", to: "/dashboard/logs-explorer", icon: Search },
  { group: "Ops & Observability", label: "Audit trail", to: "/dashboard/audit", icon: ShieldAlert },
  { group: "Ops & Observability", label: "Audit log", to: "/dashboard/audit-log", icon: ShieldAlert },
  { group: "Ops & Observability", label: "Pluto Audit", to: "/dashboard/pluto-audit", icon: History },
  { group: "Ops & Observability", label: "Scaling", to: "/dashboard/scaling", icon: Waves },
  { group: "Ops & Observability", label: "Usage & Quotas", to: "/dashboard/usage", icon: Gauge },
  { group: "Ops & Observability", label: "Billing & Alerts", to: "/dashboard/pluto-billing", icon: Gauge },

  // Platform
  { group: "Platform", label: "Projects & Keys", to: "/dashboard/projects", icon: KeyRound },
  { group: "Platform", label: "Workspaces", to: "/dashboard/workspaces", icon: Building2 },
  { group: "Platform", label: "CORS whitelist", to: "/dashboard/cors", icon: Globe },
  { group: "Platform", label: "Backups", to: "/dashboard/backups", icon: Archive },
  { group: "Platform", label: "Pluto Backups", to: "/dashboard/pluto-backups", icon: Archive },
  { group: "Platform", label: "Branching & Studio", to: "/dashboard/branching", icon: GitBranch },
  { group: "Platform", label: "Branches", to: "/dashboard/pluto-branches", icon: GitBranch },
  { group: "Platform", label: "Read Replicas", to: "/dashboard/pluto-replicas", icon: Globe },
  { group: "Platform", label: "Compliance (GDPR)", to: "/dashboard/pluto-compliance", icon: ShieldCheck },
  { group: "Platform", label: "Vault & Secrets", to: "/dashboard/pluto-vault", icon: LockKeyhole },
  { group: "Platform", label: "Enterprise", to: "/dashboard/enterprise", icon: Globe },
  { group: "Platform", label: "Marketplace", to: "/dashboard/pluto-marketplace", icon: ShoppingBag },

  // Developer
  { group: "Developer", label: "CLI & SDK", to: "/dashboard/pluto-sdk", icon: Terminal },
  { group: "Developer", label: "SDK Demo", to: "/dashboard/sdk-demo", icon: Zap },
  { group: "Developer", label: "DevEx", to: "/dashboard/devex", icon: Package },
  { group: "Developer", label: "Settings", to: "/dashboard/settings", icon: Settings },
  { group: "Developer", label: "API docs", to: "/docs/api", icon: ScrollText },
];

/** Global ⌘K / Ctrl-K palette. Mount once in the dashboard shell. */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const nav = useNavigate();
  const { signOut } = useAuth();

  React.useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Allow the shortcut even when focus is in inputs.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const isTyping =
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable);
        if (!isTyping) {
          e.preventDefault();
          setOpen(true);
        }
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    nav({ to });
  };

  const grouped = React.useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of entries) {
      if (!map.has(e.group)) map.set(e.group, []);
      map.get(e.group)!.push(e);
    }
    return Array.from(map.entries());
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search pages and jump anywhere in Pluto BaaS"
    >
      <CommandInput
        placeholder="Search pages, actions, docs…  (try ‘sql’, ‘users’, ‘logs’)"
        aria-label="Search pages and actions"
      />
      <CommandList>
        <CommandEmpty>No matches. Try a different keyword.</CommandEmpty>

        {grouped.map(([group, items], gi) => (
          <React.Fragment key={group}>
            {gi > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {items.map((i) => {
                const Icon = i.icon;
                return (
                  <CommandItem
                    key={`${group}:${i.to ?? i.action}:${i.label}`}
                    value={`${i.label} ${i.group} ${i.keywords ?? ""} ${i.to ?? ""}`}
                    onSelect={() => (i.to ? go(i.to) : undefined)}
                    className="gap-2"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1 truncate">{i.label}</span>
                    {i.to && (
                      <span className="hidden sm:inline text-[10px] text-muted-foreground/70 font-mono truncate">
                        {i.to}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </React.Fragment>
        ))}

        <CommandSeparator />
        <CommandGroup heading="Session">
          <CommandItem
            value="sign out logout"
            onSelect={async () => {
              setOpen(false);
              await signOut();
              nav({ to: "/auth", replace: true });
            }}
            className="gap-2"
          >
            <LogOut className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">Sign out</span>
            <CommandShortcut>⇧⌘Q</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
