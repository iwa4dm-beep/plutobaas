import { Building2, Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "@/lib/pluto/workspace-context";

export function WorkspaceSwitcher() {
  const { workspaces, active, setActive, loading } = useWorkspace();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative border-b border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary shrink-0">
          <Building2 className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Workspace</div>
          <div className="text-sm font-medium truncate">{active.name}</div>
        </div>
        <ChevronDown className={"h-4 w-4 text-muted-foreground transition-transform " + (open ? "rotate-180" : "")} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-2 right-2 top-full mt-1 z-20 rounded-md border border-border bg-card shadow-lg overflow-hidden">
            {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>}
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => { setActive(w.id); setOpen(false); }}
                className={"w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/60 " + (w.id === active.id ? "bg-accent/40" : "")}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{w.name}</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">{w.slug}</div>
                </div>
                {w.id === active.id && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
