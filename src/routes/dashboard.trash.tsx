import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import {
  cancelSoftDelete, purgeNow, setWindowMs, subscribe, timeRemainingMs,
  type SoftDelete,
} from "@/lib/pluto/delete-store";

export const Route = createFileRoute("/dashboard/trash")({
  head: () => ({ meta: [
    { title: "Recycle bin — Pluto" },
    { name: "description", content: "Restore or permanently purge soft-deleted users and projects." },
  ]}),
  component: TrashPage,
});

function TrashPage() {
  const [items, setItems] = useState<SoftDelete[]>([]);
  const [windowMin, setWindowMin] = useState(30);
  useEffect(() => subscribe((s) => {
    setItems(s.softDeletes);
    setWindowMin(Math.round(s.settings.windowMs / 60_000));
  }), []);
  // Tick every 30s so remaining time updates.
  useEffect(() => { const t = setInterval(() => setItems((x) => [...x]), 30_000); return () => clearInterval(t); }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recycle bin"
        description="Users and projects pending permanent purge. Restore before the window elapses to keep them."
      />

      <div className="rounded-lg border p-4 flex items-center gap-3 text-sm">
        <label className="text-muted-foreground">Undo window (minutes):</label>
        <input
          type="number" min={0} max={10080} value={windowMin}
          onChange={(e) => setWindowMs(Math.max(0, parseInt(e.target.value || "0", 10)) * 60_000)}
          className="w-24 rounded-md border border-input bg-background px-2 py-1"
        />
        <span className="text-xs text-muted-foreground">Set to 0 for immediate purge.</span>
      </div>

      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Deleted by</th>
              <th className="px-3 py-2">Remaining</th>
              <th className="px-3 py-2 w-40" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-xs text-muted-foreground">Recycle bin is empty.</td></tr>
            )}
            {items.map((sd) => {
              const remainMs = timeRemainingMs(sd);
              const remainMin = Math.max(0, Math.ceil(remainMs / 60_000));
              return (
                <tr key={sd.id} className="border-t">
                  <td className="px-3 py-2 text-xs uppercase">{sd.kind}</td>
                  <td className="px-3 py-2">
                    <div>{sd.label}</div>
                    {sd.slug && <div className="text-xs text-muted-foreground font-mono">{sd.slug}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">{sd.deletedBy.email ?? sd.deletedBy.id ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {remainMs <= 0 ? <span className="text-destructive">purging…</span> : `${remainMin} min`}
                  </td>
                  <td className="px-3 py-2 text-right space-x-1">
                    <button
                      onClick={() => cancelSoftDelete(sd.targetId)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                    >
                      <RotateCcw className="h-3 w-3" /> Restore
                    </button>
                    <button
                      onClick={() => { if (confirm(`Purge "${sd.label}" now? This cannot be undone.`)) purgeNow(sd.targetId); }}
                      className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3" /> Purge now
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
