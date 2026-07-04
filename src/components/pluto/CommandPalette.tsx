import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";

/** Global ⌘K / Ctrl-K palette. Mount once in the dashboard shell. */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const nav = useNavigate();
  React.useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const go = (to: string) => { setOpen(false); nav({ to }); };

  const items: { group: string; label: string; to: string; hint?: string }[] = [
    { group: "Navigate", label: "Home",         to: "/dashboard" },
    { group: "Navigate", label: "Database",     to: "/dashboard/database" },
    { group: "Navigate", label: "SQL editor",   to: "/dashboard/sql" },
    { group: "Navigate", label: "Storage",      to: "/dashboard/storage" },
    { group: "Navigate", label: "Auth users",   to: "/dashboard/users" },
    { group: "Navigate", label: "Team + RBAC",  to: "/dashboard/rbac" },
    { group: "Navigate", label: "Functions",    to: "/dashboard/functions" },
    { group: "Navigate", label: "Realtime",     to: "/dashboard/realtime" },
    { group: "Navigate", label: "Logs",         to: "/dashboard/logs" },
    { group: "Navigate", label: "Backups",      to: "/dashboard/backups" },
    { group: "Navigate", label: "Observability",to: "/dashboard/observability" },
    { group: "Navigate", label: "API docs",     to: "/dashboard/api" },
    { group: "Navigate", label: "Settings",     to: "/dashboard/settings" },
    { group: "Navigate", label: "Service status", to: "/status" },
  ];
  const groups = Array.from(new Set(items.map((i) => i.group)));

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to a page or run a command…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g} heading={g}>
            {items.filter((i) => i.group === g).map((i) => (
              <CommandItem key={i.to} onSelect={() => go(i.to)}>{i.label}</CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
