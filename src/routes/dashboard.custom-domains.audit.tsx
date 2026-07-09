import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, RefreshCw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import {
  clearDomainAudit,
  listDomainAudit,
  type DomainAuditAction,
  type DomainAuditEntry,
} from "@/lib/pluto/domain-audit";

export const Route = createFileRoute("/dashboard/custom-domains/audit")({
  head: () => ({
    meta: [
      { title: "Domain audit log — Pluto" },
      { name: "description", content: "Per-workspace audit trail of custom-domain operations (add, verify, primary, remove, test)." },
    ],
  }),
  component: DomainAuditPage,
});

const ACTION_LABEL: Record<DomainAuditAction, string> = {
  "domain.add": "Added",
  "domain.verify": "Verified",
  "domain.remove": "Removed",
  "domain.make_primary": "Set primary",
  "domain.clear_primary": "Cleared primary",
  "domain.test_endpoint": "Tested endpoint",
};

const ACTION_TONE: Record<DomainAuditAction, string> = {
  "domain.add": "bg-blue-500/15 text-blue-300",
  "domain.verify": "bg-emerald-500/15 text-emerald-300",
  "domain.remove": "bg-red-500/15 text-red-300",
  "domain.make_primary": "bg-amber-500/15 text-amber-300",
  "domain.clear_primary": "bg-muted text-muted-foreground",
  "domain.test_endpoint": "bg-purple-500/15 text-purple-300",
};

function DomainAuditPage() {
  const { active } = useWorkspace();
  const workspaceId = active?.id ?? "root";
  const [items, setItems] = useState<DomainAuditEntry[]>([]);
  const [filter, setFilter] = useState<"all" | DomainAuditAction>("all");
  const [query, setQuery] = useState("");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setItems(listDomainAudit(workspaceId));
  }, [workspaceId, nonce]);

  const filtered = useMemo(() => {
    return items.filter((e) => {
      if (filter !== "all" && e.action !== filter) return false;
      if (query && !`${e.hostname} ${e.actor}`.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [items, filter, query]);

  function exportCsv() {
    const header = "timestamp,actor,action,hostname,status,meta\n";
    const rows = filtered.map((e) =>
      [e.ts, e.actor, e.action, e.hostname, e.status, JSON.stringify(e.meta ?? {})]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `custom-domain-audit-${workspaceId}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link
          to="/dashboard/custom-domains"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Custom domains
        </Link>
      </div>
      <PageHeader
        title="Domain audit log"
        description="Every add / verify / primary / remove / test event for this workspace, with actor and timestamp."
      />
      <AutoHelpPanel
        slug="dashboard.custom-domains.audit"
        title="Domain audit log"
        description="Persistent per-workspace audit trail for custom-domain operations. Exportable to CSV for compliance review."
      />

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          <option value="all">All actions</option>
          {Object.entries(ACTION_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by hostname or actor…"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs font-mono"
        />
        <button
          onClick={() => setNonce((n) => n + 1)}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </button>
        <button
          onClick={() => {
            if (!confirm("Clear the entire audit log for this workspace? This cannot be undone.")) return;
            clearDomainAudit(workspaceId);
            setNonce((n) => n + 1);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" /> Clear
        </button>
      </div>

      <section className="rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-2">Time</th>
              <th className="text-left px-4 py-2">Actor</th>
              <th className="text-left px-4 py-2">Action</th>
              <th className="text-left px-4 py-2">Hostname</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No audit entries yet.
                </td>
              </tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id} className="border-t border-border align-top">
                <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(e.ts).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-xs font-mono">{e.actor}</td>
                <td className="px-4 py-2 text-xs">
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase ${ACTION_TONE[e.action]}`}>
                    {ACTION_LABEL[e.action]}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-xs">{e.hostname}</td>
                <td className="px-4 py-2 text-xs">
                  {e.status === "ok" ? (
                    <span className="text-emerald-300">ok</span>
                  ) : (
                    <span className="text-red-300">error</span>
                  )}
                </td>
                <td className="px-4 py-2 text-[11px] text-muted-foreground max-w-[380px]">
                  {e.meta && Object.keys(e.meta).length > 0 ? (
                    <code className="block truncate font-mono" title={JSON.stringify(e.meta)}>
                      {JSON.stringify(e.meta)}
                    </code>
                  ) : (
                    <span className="opacity-60">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
