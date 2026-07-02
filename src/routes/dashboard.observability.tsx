import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Play, Download, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, observability, type GdprRequest, type MetricPoint, type TraceSpan, type TraceSummary } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/observability")({
  component: ObservabilityPage,
});

// Observability & Compliance dashboard (Phase 18). Metric rollups,
// Prometheus /metrics preview, recent request traces with drill-down,
// and the GDPR export/erasure workflow.

function ObservabilityPage() {
  const [metric, setMetric] = useState("http.request");
  const [agg, setAgg] = useState<"avg" | "sum" | "count" | "p95">("avg");
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [prom, setProm] = useState("");
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [openTrace, setOpenTrace] = useState<{ trace_id: string; spans: TraceSpan[] } | null>(null);
  const [gdpr, setGdpr] = useState<GdprRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [subjectId, setSubjectId] = useState("");

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured."); return; }
    setLoading(true); setErr(null);
    try {
      const [q, p, g, t] = await Promise.all([
        observability.queryMetric(metric, agg, 60),
        observability.metricsText().catch(() => observability.prometheus().then((r) => r.body)),
        observability.gdprList(),
        observability.traces(25),
      ]);
      setPoints(q.points); setProm(p); setGdpr(g.requests); setTraces(t.traces);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [metric, agg]);
  useEffect(() => { void load(); }, [load]);

  const openRequest = async (kind: "export" | "erasure") => {
    if (!subjectId) return;
    try { await observability.gdprCreate(subjectId, kind); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const runRequest = async (id: string) => { await observability.gdprRun(id); await load(); };
  const openTraceDetail = async (traceId: string) => {
    try { setOpenTrace(await observability.trace(traceId)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };


  const max = points.reduce((m, p) => Math.max(m, p.v), 0) || 1;

  return (
    <div className="space-y-6">
      <PageHeader title="Observability & Compliance" description="Metrics, traces, and GDPR data-subject requests"
        actions={<button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </button>} />

      {err && <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-500">{err}</div>}

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs"><div className="text-muted-foreground">Metric</div>
            <input value={metric} onChange={(e) => setMetric(e.target.value)}
              className="mt-0.5 rounded-md border border-border bg-background px-2 py-1 text-sm font-mono" />
          </label>
          <label className="text-xs"><div className="text-muted-foreground">Agg</div>
            <select value={agg} onChange={(e) => setAgg(e.target.value as typeof agg)}
              className="mt-0.5 rounded-md border border-border bg-background px-2 py-1 text-sm">
              <option>avg</option><option>sum</option><option>count</option><option>p95</option>
            </select>
          </label>
        </div>
        <div className="flex items-end gap-0.5 h-32">
          {points.length === 0 && <div className="text-sm text-muted-foreground self-center">No samples in the last 60 minutes.</div>}
          {points.map((p) => (
            <div key={p.bucket} className="flex-1 bg-primary/60 rounded-t" style={{ height: `${(p.v / max) * 100}%` }}
              title={`${p.bucket}: ${p.v}`} />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold">Prometheus /metrics (last 5 min)</div>
          <a href={(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_PLUTO_URL
              ? `${(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_PLUTO_URL!.replace(/\/$/, "")}/metrics`
              : "#"}
             target="_blank" rel="noreferrer"
             className="text-xs inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            open <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <pre className="text-xs bg-muted/40 rounded-md p-3 max-h-56 overflow-auto">{prom || "# no samples"}</pre>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Recent request traces (last hour)</div>
        <div className="text-xs text-muted-foreground">
          Every request is tagged with an <code>x-trace-id</code> response header. Click a trace to see its span tree.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr><th className="py-1">Trace</th><th>Root</th><th>Status</th><th>Duration</th><th>Spans</th><th></th></tr>
            </thead>
            <tbody>
              {traces.length === 0 && <tr><td colSpan={6} className="py-2 text-muted-foreground">No traces yet — send a request.</td></tr>}
              {traces.map((t) => (
                <tr key={t.trace_id} className="border-t border-border/60">
                  <td className="py-1 font-mono truncate max-w-[10rem]">{t.trace_id.slice(0, 8)}…</td>
                  <td className="font-mono truncate max-w-[16rem]">{t.root_name}</td>
                  <td className={t.root_status && Number(t.root_status) >= 400 ? "text-rose-500" : ""}>{t.root_status ?? "—"}</td>
                  <td>{t.total_ms} ms</td>
                  <td>{t.spans}</td>
                  <td><button onClick={() => void openTraceDetail(t.trace_id)}
                    className="rounded-md border border-border px-2 py-0.5 hover:bg-accent">inspect</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {openTrace && (
          <div className="rounded-md border border-border p-3 bg-muted/30">
            <div className="flex items-center justify-between mb-2">
              <div className="font-mono text-xs">trace {openTrace.trace_id}</div>
              <button onClick={() => setOpenTrace(null)} className="text-xs text-muted-foreground hover:text-foreground">close</button>
            </div>
            <ul className="text-xs space-y-1">
              {openTrace.spans.map((s) => (
                <li key={s.span_id} className="flex justify-between gap-2">
                  <span className="font-mono truncate">{s.name}</span>
                  <span className="text-muted-foreground">{s.kind} · {s.duration_ms ?? "?"} ms</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">GDPR data-subject requests</div>
        <div className="text-xs text-muted-foreground">
          Admins can request an <b>export</b> (bundles user, sessions, audit as JSON artifact) or an <b>erasure</b>
          (redacts PII while keeping audit tombstones). Runs are gated by <code>service_role</code> + admin JWT.
        </div>
        <div className="flex gap-2 items-end flex-wrap">
          <label className="text-xs flex-1 min-w-[16rem]"><div className="text-muted-foreground">Subject user id (uuid)</div>
            <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="00000000-0000-0000-0000-…"
              className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-sm font-mono" />
          </label>
          <button onClick={() => void openRequest("export")}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent">Request export</button>
          <button onClick={() => void openRequest("erasure")}
            className="rounded-md bg-rose-500/10 border border-rose-500/40 text-rose-500 px-3 py-1.5 text-sm">Request erasure</button>
        </div>
        <ul className="text-sm divide-y divide-border">
          {gdpr.length === 0 && <li className="py-2 text-muted-foreground">No requests yet.</li>}
          {gdpr.map((g) => (
            <li key={g.id} className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono text-xs truncate flex-1">{g.subject_id}</span>
              <span className="text-xs w-16">{g.kind}</span>
              <span className={`text-xs w-20 ${g.status === "completed" ? "text-emerald-500" : g.status === "failed" ? "text-rose-500" : "text-muted-foreground"}`}>{g.status}</span>
              {g.artifact_key && (
                <span className="text-xs inline-flex items-center gap-1 text-muted-foreground">
                  <Download className="h-3 w-3" /> <span className="font-mono truncate max-w-[12rem]">{g.artifact_key}</span>
                </span>
              )}
              {g.status === "pending" && (
                <button onClick={() => void runRequest(g.id)}
                  className="inline-flex items-center gap-1 text-xs rounded-md border border-border px-2 py-1 hover:bg-accent">
                  <Play className="h-3 w-3" /> run
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

    </div>
  );
}
