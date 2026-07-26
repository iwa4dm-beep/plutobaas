import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { subscribe, type AuditEntry } from "@/lib/pluto/delete-store";

export const Route = createFileRoute("/dashboard/audit/deletes")({
  head: () => ({ meta: [
    { title: "Delete audit log — Pluto" },
    { name: "description", content: "Who deleted which user or project, when, and the VPS purge outcome." },
  ]}),
  component: AuditPage,
});

const actionLabel: Record<AuditEntry["action"], string> = {
  soft_delete_project: "Soft-delete project",
  soft_delete_user: "Soft-delete user",
  restore_project: "Restore project",
  restore_user: "Restore user",
  purge_project: "Purge project",
  purge_user: "Purge user",
};

function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState<"all" | AuditEntry["action"]>("all");
  useEffect(() => subscribe((s) => setEntries(s.audit)), []);

  const filtered = useMemo(() => entries.filter((e) => {
    if (action !== "all" && e.action !== action) return false;
    if (actor && !(e.actor.email ?? "").toLowerCase().includes(actor.toLowerCase())) return false;
    return true;
  }), [entries, actor, action]);

  function exportCsv() {
    const rows = [
      ["at", "actor", "action", "target", "targetId", "dbOk", "dbError", "vpsOk", "vpsRemoved", "vpsErrors"],
      ...filtered.map((e) => [
        e.at, e.actor.email ?? e.actor.id ?? "", e.action, e.targetLabel, e.targetId,
        String(e.dbOk ?? ""), e.dbError ?? "", String(e.vpsOk ?? ""),
        (e.vpsRemoved ?? []).length.toString(), (e.vpsErrors ?? []).join("|"),
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `delete-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Delete audit log"
        description="Every soft-delete, restore, and purge is recorded with the actor and VPS outcome."
        actions={
          <button onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-muted">
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
        <input placeholder="Filter by actor email…" value={actor} onChange={(e) => setActor(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs" />
        <select value={action} onChange={(e) => setAction(e.target.value as typeof action)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs">
          <option value="all">All actions</option>
          {Object.entries(actionLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} entr{filtered.length === 1 ? "y" : "ies"}</span>
      </div>

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">DB</th>
              <th className="px-3 py-2">VPS</th>
              <th className="px-3 py-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-xs text-muted-foreground">No matching entries.</td></tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id} className="border-t align-top">
                <td className="px-3 py-2 text-xs">{new Date(e.at).toLocaleString()}</td>
                <td className="px-3 py-2 text-xs">{e.actor.email ?? e.actor.id ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{actionLabel[e.action]}</td>
                <td className="px-3 py-2">
                  <div>{e.targetLabel}</div>
                  <div className="text-xs font-mono text-muted-foreground">{e.targetId}</div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {e.dbOk === true ? "ok" : e.dbOk === false ? <span className="text-destructive">failed</span> : "—"}
                </td>
                <td className="px-3 py-2 text-xs">
                  {e.vpsOk === true ? `ok (${(e.vpsRemoved ?? []).length} paths)` :
                   e.vpsOk === false ? <span className="text-destructive">failed</span> : "—"}
                </td>
                <td className="px-3 py-2 text-xs">
                  {e.dbError && <div className="text-destructive break-all">DB: {e.dbError}</div>}
                  {(e.vpsErrors ?? []).length ? <div className="text-destructive break-all">{(e.vpsErrors ?? []).join("; ")}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
