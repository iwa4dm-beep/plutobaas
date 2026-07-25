import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, Clock, Database,
  HardDriveDownload, HeartPulse, RefreshCw, RotateCcw, ShieldAlert,
  ShieldCheck, Undo2, XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import {
  listOpsAudit, type OpsAuditEntry, type OpsEnv,
} from "@/lib/pluto/vps-ops.functions";

export const Route = createFileRoute("/dashboard/ops/executions")({
  component: ExecutionsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    env: (s.env === "dev" || s.env === "staging" || s.env === "prod" ? s.env : "prod") as OpsEnv,
    action: typeof s.action === "string" ? s.action : "",
    outcome: (s.outcome === "ok" || s.outcome === "failed" || s.outcome === "" ? s.outcome : "") as "" | "ok" | "failed",
  }),
  head: () => ({
    meta: [
      { title: "Ops Executions Timeline — Pluto BaaS" },
      { name: "description", content: "Chronological timeline of every migration, rollout, restart, and backup execution — with progress, logs, and final status." },
      { property: "og:title", content: "Ops Executions Timeline — Pluto BaaS" },
      { property: "og:description", content: "Live timeline of Pluto BaaS ops jobs with per-run logs and outcome." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function ExecutionsPage() {
  return (
    <TraceAccessGate permission="view">
      <ExecutionsInner />
    </TraceAccessGate>
  );
}

const ACTION_ICON: Record<string, typeof Database> = {
  "migrations-plan": Database,
  "migrations-dry-run": Database,
  "migrations-apply": Database,
  "migrations-rollback-plan": Undo2,
  "migrations-rollback-apply": Undo2,
  "service-restart": RotateCcw,
  "service-rollout": RotateCcw,
  "service-health": HeartPulse,
  "backup-create": HardDriveDownload,
  "backup-restore": HardDriveDownload,
};

function actionColour(action: string): string {
  if (action.startsWith("migrations-rollback")) return "text-amber-600";
  if (action.startsWith("migrations")) return "text-primary";
  if (action.startsWith("service")) return "text-blue-600";
  if (action.startsWith("backup")) return "text-emerald-600";
  return "text-muted-foreground";
}

function ExecutionsInner() {
  const { env, action, outcome } = Route.useSearch();
  const navigate = Route.useNavigate();
  const listAudit = useServerFn(listOpsAudit);
  const [entries, setEntries] = useState<OpsAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listAudit({ data: { env, action: action || undefined, limit: 200 } });
      setEntries(r.entries || []); setError(r.error || null);
    } finally { setLoading(false); }
  }, [listAudit, env, action]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => { void load(); }, 8000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  const filtered = useMemo(() => {
    if (!outcome) return entries;
    return entries.filter((e) => (outcome === "ok" ? e.ok : !e.ok));
  }, [entries, outcome]);

  const summary = useMemo(() => {
    const total = filtered.length;
    const ok = filtered.filter((e) => e.ok).length;
    const failed = total - ok;
    const totalMs = filtered.reduce((n, e) => n + (e.durationMs || 0), 0);
    return { total, ok, failed, totalMs };
  }, [filtered]);

  const toggle = (id: string) => {
    setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Executions timeline"
        description="Every migration plan/apply, rollback, service restart/rollout, and backup — chronologically, with progress, logs, and final status."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Link to="/dashboard/ops" search={{ env }} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Operations
        </Link>
        <span className="mx-2 text-xs text-muted-foreground">env:</span>
        {(["dev", "staging", "prod"] as OpsEnv[]).map((e) => (
          <button key={e} onClick={() => navigate({ search: { env: e, action, outcome } })}
            className={`rounded-full border px-3 py-1 text-xs uppercase ${env === e ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
            {e}
          </button>
        ))}
        <select
          value={action} onChange={(e) => navigate({ search: { env, action: e.target.value, outcome } })}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          {["", "migrations-plan", "migrations-dry-run", "migrations-apply",
            "migrations-rollback-plan", "migrations-rollback-apply",
            "service-restart", "service-rollout", "service-health",
            "backup-create", "backup-restore",
          ].map((a) => <option key={a} value={a}>{a || "all actions"}</option>)}
        </select>
        <select
          value={outcome} onChange={(e) => navigate({ search: { env, action, outcome: e.target.value as "" | "ok" | "failed" } })}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">any outcome</option>
          <option value="ok">succeeded</option>
          <option value="failed">failed</option>
        </select>
        <label className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh 8s
        </label>
        <button onClick={() => void load()} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryTile label="Runs" value={String(summary.total)} icon={Clock} />
        <SummaryTile label="Succeeded" value={String(summary.ok)} icon={CheckCircle2} tone="ok" />
        <SummaryTile label="Failed" value={String(summary.failed)} icon={XCircle} tone={summary.failed ? "bad" : "muted"} />
        <SummaryTile label="Total time" value={fmtMs(summary.totalMs)} icon={ShieldCheck} />
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <ol className="relative border-s border-border/60 ps-6">
        {filtered.map((e) => {
          const Icon = ACTION_ICON[e.action] ?? ShieldAlert;
          const open = expanded.has(e.id);
          const isRollback = e.action.startsWith("migrations-rollback");
          return (
            <li key={e.id} className="mb-6 last:mb-2">
              <span className={`absolute -start-3 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-background ${e.ok ? "bg-emerald-500/20" : "bg-red-500/20"}`}>
                <Icon className={`h-3.5 w-3.5 ${actionColour(e.action)}`} />
              </span>
              <button
                onClick={() => toggle(e.id)}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm hover:bg-accent/40"
              >
                {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                <span className="font-mono text-xs">{e.action}</span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase text-muted-foreground">{e.env}</span>
                {isRollback && <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase text-amber-700 dark:text-amber-300">rollback</span>}
                {e.service && <span className="text-xs text-muted-foreground">· {e.service}</span>}
                {e.params?.plan && <span className="text-xs text-muted-foreground">· plan={e.params.plan}</span>}
                {e.params?.target && <span className="text-xs text-muted-foreground">· target={e.params.target}</span>}
                <span className="ml-auto text-xs text-muted-foreground">{new Date(e.startedAt).toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">{fmtMs(e.durationMs)}</span>
                {e.ok
                  ? <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" /> succeeded</span>
                  : <span className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-500/20 dark:text-red-300"><XCircle className="h-3 w-3" /> exit {e.exitCode}</span>}
              </button>
              {open && (
                <div className="mt-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
                  <div className="mb-2 grid gap-1 md:grid-cols-3">
                    <Detail k="Actor" v={e.actorEmail || e.actorUserId || "—"} />
                    <Detail k="Started" v={new Date(e.startedAt).toLocaleString()} />
                    <Detail k="Finished" v={new Date(e.finishedAt).toLocaleString()} />
                    <Detail k="Duration" v={fmtMs(e.durationMs)} />
                    <Detail k="Exit" v={String(e.exitCode)} />
                    {e.backupId ? <Detail k="Backup" v={e.backupId} mono /> : null}
                  </div>
                  {e.hint && <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-amber-700 dark:text-amber-300">{e.hint}</div>}
                  <div className="mb-1 text-[10px] uppercase text-muted-foreground">Log tail</div>
                  <pre className="max-h-72 overflow-auto rounded bg-background p-2 text-[11px] leading-relaxed whitespace-pre-wrap">{e.tail || "(no output captured)"}</pre>
                </div>
              )}
            </li>
          );
        })}
        {filtered.length === 0 && !loading && (
          <li className="py-8 text-center text-sm text-muted-foreground">No executions match the current filters.</li>
        )}
      </ol>
    </div>
  );
}

function Detail({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="text-xs">
      <span className="text-muted-foreground">{k}: </span>
      <span className={mono ? "font-mono" : ""}>{v}</span>
    </div>
  );
}

function SummaryTile({ label, value, icon: Icon, tone }: { label: string; value: string; icon: typeof Clock; tone?: "ok" | "bad" | "muted" }) {
  const cls =
    tone === "ok" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : tone === "muted" ? "text-muted-foreground" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" /> {label}</div>
      <div className={`mt-1 text-2xl font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function fmtMs(ms: number): string {
  if (!ms) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}
