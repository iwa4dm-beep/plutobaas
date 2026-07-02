import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Play } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, observability, type GdprRequest, type MetricPoint } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/observability")({
  component: ObservabilityPage,
});

// Observability & Compliance dashboard (Phase 18). Live metric
// rollup, Prometheus scrape preview, and GDPR request workflow.

function ObservabilityPage() {
  const [metric, setMetric] = useState("http.request");
  const [agg, setAgg] = useState<"avg" | "sum" | "count" | "p95">("avg");
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [prom, setProm] = useState("");
  const [gdpr, setGdpr] = useState<GdprRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [subjectId, setSubjectId] = useState("");

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured."); return; }
    setLoading(true); setErr(null);
    try {
      const [q, p, g] = await Promise.all([
        observability.queryMetric(metric, agg, 60),
        observability.prometheus(),
        observability.gdprList(),
      ]);
      setPoints(q.points); setProm(p.body); setGdpr(g.requests);
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
        <div className="font-semibold mb-2">Prometheus exposition (last 5 min)</div>
        <pre className="text-xs bg-muted/40 rounded-md p-3 max-h-56 overflow-auto">{prom || "# no samples"}</pre>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">GDPR requests</div>
        <div className="flex gap-2 items-end">
          <label className="text-xs flex-1"><div className="text-muted-foreground">Subject user id (uuid)</div>
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
              <span className="font-mono text-xs truncate">{g.subject_id}</span>
              <span className="text-xs">{g.kind}</span>
              <span className="text-xs text-muted-foreground">{g.status}</span>
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
