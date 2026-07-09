// Backend audit panel — surfaces per-route health of the proxy → API pipeline
// and the last observed failure reason. Reads /api/pluto/audit which probes
// several critical upstream endpoints and returns a matrix.
import { useCallback, useEffect, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";

type ProbeResult = {
  path: string; label: string; ok: boolean; status: number | null;
  latencyMs: number; error: string | null;
};
type AuditResponse = {
  ok: boolean; configured: boolean; upstreamUrl: string | null;
  issues: string[]; reachable: boolean; results: ProbeResult[];
  failingCount: number; lastOkAt: number | null; lastErrorAt: number | null;
  lastError: string | null; lastPath: string | null; checkedAt: number;
};

function fmtAgo(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function BackendAuditPanel() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/pluto/audit", { cache: "no-store" });
      if (!r.ok) throw new Error(`audit endpoint returned HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const okAll = data?.ok ?? false;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Backend health audit</h2>
          {data && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                okAll
                  ? "bg-green-500/15 text-green-500"
                  : "bg-red-500/15 text-red-500"
              }`}
            >
              {okAll ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
              {okAll ? "healthy" : `${data.failingCount} failing`}
            </span>
          )}
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Re-check
        </button>
      </div>

      {err && (
        <div className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-500">
          {err}
        </div>
      )}

      {data && (
        <>
          <div className="mb-2 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
            <Metric label="Upstream" value={data.upstreamUrl ? new URL(data.upstreamUrl).host : "—"} />
            <Metric label="Configured" value={data.configured ? "yes" : "no"} />
            <Metric label="Last success" value={fmtAgo(data.lastOkAt)} />
            <Metric label="Last failure" value={fmtAgo(data.lastErrorAt)} />
          </div>

          {data.issues.length > 0 && (
            <ul className="mb-2 rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-[11px] text-yellow-300">
              {data.issues.map((i, idx) => <li key={idx}>• {i}</li>)}
            </ul>
          )}

          {data.lastError && (
            <div className="mb-2 rounded-md border border-border/60 bg-muted/30 p-2 text-[11px]">
              <div className="mb-0.5 text-muted-foreground">Last observed failure {data.lastPath ? `on ${data.lastPath}` : ""}:</div>
              <div className="whitespace-pre-wrap break-all font-mono text-red-400">{data.lastError}</div>
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-border/60">
            <table className="w-full text-[11px]">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Route</th>
                  <th className="px-2 py-1 text-left font-medium">Status</th>
                  <th className="px-2 py-1 text-right font-medium">Latency</th>
                  <th className="px-2 py-1 text-left font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {data.results.map((r) => (
                  <tr key={r.path} className={r.ok ? "" : "bg-red-500/5"}>
                    <td className="px-2 py-1">
                      <div className="font-medium">{r.label}</div>
                      <div className="font-mono text-muted-foreground">{r.path}</div>
                    </td>
                    <td className="px-2 py-1">
                      <span className={r.ok ? "text-green-500" : "text-red-500"}>
                        {r.ok ? "OK" : "FAIL"}{r.status != null ? ` · ${r.status}` : ""}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{r.latencyMs}ms</td>
                    <td className="px-2 py-1 text-red-400">{r.error ?? ""}</td>
                  </tr>
                ))}
                {data.results.length === 0 && (
                  <tr><td colSpan={4} className="px-2 py-3 text-center text-muted-foreground">
                    Upstream not configured — nothing to probe.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Checked {fmtAgo(data.checkedAt)}. Probes run server-side against the configured upstream origin.
          </p>
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/60 p-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="truncate font-mono">{value}</div>
    </div>
  );
}
