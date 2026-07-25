import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import { listOpsAudit, type OpsAuditEntry, type OpsEnv } from "@/lib/pluto/vps-ops.functions";

export const Route = createFileRoute("/dashboard/ops/audit")({
  component: AuditPage,
  validateSearch: (s: Record<string, unknown>) => ({
    env: (s.env === "dev" || s.env === "staging" || s.env === "prod" ? s.env : "prod") as OpsEnv,
    action: typeof s.action === "string" ? s.action : "",
    actor: typeof s.actor === "string" ? s.actor : "",
  }),
  head: () => ({
    meta: [
      { title: "Ops Audit Log — Pluto BaaS" },
      { name: "description", content: "Every migration and service restart on the Pluto VPS — who, when, and result." },
      { property: "og:title", content: "Ops Audit Log — Pluto BaaS" },
      { property: "og:description", content: "Auditable history of Pluto backend operations." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function AuditPage() {
  return (
    <TraceAccessGate permission="manage">
      <AuditPageInner />
    </TraceAccessGate>
  );
}

const ACTIONS = [
  "", "migrations-plan", "migrations-dry-run", "migrations-apply",
  "migrations-rollback-plan", "migrations-rollback-apply",
  "service-restart", "service-rollout", "service-health",
  "backup-create", "backup-restore",
];

function AuditPageInner() {
  const { env, action, actor } = Route.useSearch();
  const navigate = Route.useNavigate();
  const list = useServerFn(listOpsAudit);
  const [entries, setEntries] = useState<OpsAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<OpsAuditEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await list({ data: { env, action: action || undefined, actor: actor || undefined, limit: 200 } })) as { ok: boolean; entries: OpsAuditEntry[]; error?: string };
      setEntries(r.entries || []); setError(r.error || null);
    } finally { setLoading(false); }
  }, [list, env, action, actor]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Ops audit log"
        description="Every migration plan/dry-run/apply, rollback, service restart, and backup — with actor and result."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link to="/dashboard/ops" search={{ env }} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Operations
        </Link>
        <span className="mx-2 text-xs text-muted-foreground">env:</span>
        {(["dev", "staging", "prod"] as OpsEnv[]).map((e) => (
          <button key={e} onClick={() => navigate({ search: { env: e, action, actor } })}
            className={`rounded-full border px-3 py-1 text-xs uppercase ${env === e ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
            {e}
          </button>
        ))}
        <select
          value={action} onChange={(e) => navigate({ search: { env, action: e.target.value, actor } })}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          {ACTIONS.map((a) => <option key={a} value={a}>{a || "all actions"}</option>)}
        </select>
        <input
          value={actor} onChange={(e) => navigate({ search: { env, action, actor: e.target.value } })}
          placeholder="filter by actor email/id"
          className="rounded-md border border-border bg-background px-2 py-1 text-xs w-52"
        />
        <button onClick={() => void load()} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="p-2">When</th>
              <th className="p-2">Env</th>
              <th className="p-2">Action</th>
              <th className="p-2">Service / Params</th>
              <th className="p-2">Actor</th>
              <th className="p-2">Duration</th>
              <th className="p-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-border cursor-pointer hover:bg-accent/40" onClick={() => setSelected(e)}>
                <td className="p-2 whitespace-nowrap">{new Date(e.startedAt).toLocaleString()}</td>
                <td className="p-2 uppercase">{e.env}</td>
                <td className="p-2 font-mono">{e.action}</td>
                <td className="p-2 truncate max-w-[240px]">
                  {e.service ?? ""}
                  {e.params?.target ? ` target=${e.params.target}` : ""}
                  {e.params?.plan ? ` plan=${e.params.plan}` : ""}
                  {e.params?.id ? ` id=${e.params.id}` : ""}
                  {e.params?.allowMissingDown ? " allow-missing-down" : ""}
                </td>
                <td className="p-2 truncate max-w-[180px]" title={e.actorEmail ?? e.actorUserId ?? ""}>{e.actorEmail || e.actorUserId || "—"}</td>
                <td className="p-2 whitespace-nowrap">{e.durationMs}ms</td>
                <td className="p-2">
                  {e.ok ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3 w-3" /> ok</span>
                        : <span className="inline-flex items-center gap-1 text-red-600"><XCircle className="h-3 w-3" /> exit {e.exitCode}</span>}
                </td>
              </tr>
            ))}
            {entries.length === 0 && !loading && (
              <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">No audit entries.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setSelected(null)}>
          <div className="bg-card rounded-xl border border-border max-w-2xl w-full max-h-[80vh] overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <div className="font-semibold">{selected.action}</div>
              <span className="text-xs uppercase text-muted-foreground">{selected.env}</span>
              <button onClick={() => setSelected(null)} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Close</button>
            </div>
            <div className="text-xs text-muted-foreground mb-2">
              {new Date(selected.startedAt).toLocaleString()} → {new Date(selected.finishedAt).toLocaleString()} · {selected.durationMs}ms · exit {selected.exitCode}
            </div>
            <div className="text-xs mb-2"><b>Actor:</b> {selected.actorEmail || selected.actorUserId || "—"}</div>
            <div className="text-xs mb-2"><b>Params:</b> <code>{JSON.stringify(selected.params ?? {})}</code></div>
            {selected.backupId && <div className="text-xs mb-2"><b>Backup:</b> <code>{selected.backupId}</code></div>}
            {selected.hint && <div className="text-xs mb-2 text-amber-600">{selected.hint}</div>}
            <pre className="max-h-80 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed">{selected.tail}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
