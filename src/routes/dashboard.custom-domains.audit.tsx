import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Cloud, Download, RefreshCw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import { isLive, live, type AuditEvent } from "@/lib/pluto/live";
import {
  clearDomainAudit,
  listDomainAudit,
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

type NormEntry = {
  id: string;
  ts: string;
  actor: string;
  action: string;
  hostname: string;
  status: string;
  metadata: Record<string, unknown>;
  source: "backend" | "local";
};

const ACTION_LABEL: Record<string, string> = {
  "domain.add": "Added",
  "domain.verify": "Verified",
  "domain.remove": "Removed",
  "domain.make_primary": "Set primary",
  "domain.clear_primary": "Cleared primary",
  "domain.test_endpoint": "Tested endpoint",
  "domain.webhook_rotate": "Rotated webhook secret",
  "domain.webhook.verified": "Webhook · verified",
  "domain.webhook.verify_failed": "Webhook · verify failed",
  "domain.webhook.cert_issued": "Webhook · cert issued",
  "domain.webhook.cert_failed": "Webhook · cert failed",
};

const ACTION_TONE: Record<string, string> = {
  "domain.add": "bg-blue-500/15 text-blue-300",
  "domain.verify": "bg-emerald-500/15 text-emerald-300",
  "domain.remove": "bg-red-500/15 text-red-300",
  "domain.make_primary": "bg-amber-500/15 text-amber-300",
  "domain.clear_primary": "bg-muted text-muted-foreground",
  "domain.test_endpoint": "bg-purple-500/15 text-purple-300",
  "domain.webhook_rotate": "bg-cyan-500/15 text-cyan-300",
};

function fromBackend(e: AuditEvent): NormEntry {
  const meta = (e.metadata ?? {}) as Record<string, unknown>;
  return {
    id: e.id,
    ts: e.ts,
    actor: e.actor_email ?? e.actor_id ?? (e.actor_role ?? "system"),
    action: e.action,
    hostname: e.target ?? String(meta.hostname ?? ""),
    status: e.status,
    metadata: meta,
    source: "backend",
  };
}

function fromLocal(e: DomainAuditEntry): NormEntry {
  return {
    id: e.id,
    ts: e.ts,
    actor: e.actor,
    action: e.action,
    hostname: e.hostname,
    status: e.status,
    metadata: e.meta ?? {},
    source: "local",
  };
}

function DomainAuditPage() {
  const { active } = useWorkspace();
  const workspaceId = active?.id ?? "root";
  const [items, setItems] = useState<NormEntry[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<"backend" | "local" | "mixed">("local");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const local = listDomainAudit(workspaceId).map(fromLocal);
    let backend: NormEntry[] = [];
    let hadBackend = false;
    if (isLive()) {
      try {
        // Backend audit list supports action prefix (ends with '*') and a
        // workspace_id filter matched against metadata->>'workspace_id'.
        const page = await live.audit.list({
          workspace_id: workspaceId,
          action: "domain.*",
          limit: 200,
        });
        backend = page.items.map(fromBackend);
        hadBackend = true;
      } catch (e) {
        setErr(e);
      }
    }
    // Merge — backend rows win when a duplicate id exists.
    const merged = new Map<string, NormEntry>();
    for (const e of local) merged.set(e.id, e);
    for (const e of backend) merged.set(e.id, e);
    setSource(hadBackend ? (local.length > 0 ? "mixed" : "backend") : "local");
    setItems([...merged.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1)));
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    return items.filter((e) => {
      if (filter !== "all" && e.action !== filter) return false;
      if (query && !`${e.hostname} ${e.actor} ${e.action}`.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [items, filter, query]);

  function exportCsv() {
    const header = "timestamp,source,actor,action,hostname,status,metadata\n";
    const rows = filtered.map((e) =>
      [e.ts, e.source, e.actor, e.action, e.hostname, e.status, JSON.stringify(e.metadata)]
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
        description="Every add / verify / primary / remove / test / webhook event for this workspace — persisted server-side, with actor and timestamp."
      />
      <AutoHelpPanel
        slug="dashboard.custom-domains.audit"
        title="Domain audit log"
        description="Backend-persisted audit trail (public.audit_events, filtered on metadata.workspace_id) merged with any local Test-endpoint entries."
      />

      <ErrorBanner error={err} onRetry={() => void load()} onDismiss={() => setErr(null)} />

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-[10px] uppercase text-muted-foreground">
          <Cloud className="h-3 w-3" />
          Source: {source}
        </span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
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
          placeholder="Filter by hostname, actor, action…"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs font-mono"
        />
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
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
            if (!confirm("Clear local Test-endpoint audit entries for this workspace? Backend-persisted entries stay.")) return;
            clearDomainAudit(workspaceId);
            void load();
          }}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" /> Clear local
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
                  <div className="text-[9px] uppercase opacity-60">{e.source}</div>
                </td>
                <td className="px-4 py-2 text-xs font-mono break-all">{e.actor}</td>
                <td className="px-4 py-2 text-xs">
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase ${ACTION_TONE[e.action] ?? "bg-muted text-muted-foreground"}`}>
                    {ACTION_LABEL[e.action] ?? e.action}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-xs">{e.hostname}</td>
                <td className="px-4 py-2 text-xs">
                  {e.status === "ok" ? (
                    <span className="text-emerald-300">ok</span>
                  ) : (
                    <span className="text-red-300">{e.status}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-[11px] text-muted-foreground max-w-[380px]">
                  {e.metadata && Object.keys(e.metadata).length > 0 ? (
                    <code className="block truncate font-mono" title={JSON.stringify(e.metadata)}>
                      {JSON.stringify(e.metadata)}
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
