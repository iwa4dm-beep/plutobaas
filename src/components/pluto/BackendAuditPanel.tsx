// Backend audit panel — surfaces per-route health of the proxy → API pipeline
// with per-route expandable details (status, latency, retry attempts, error
// body snippet) and the last observed failure reason.
import { Fragment, useCallback, useEffect, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";

type Attempt = {
  attempt: number; ok: boolean; status: number | null;
  latencyMs: number; error: string | null; waitedMs: number;
};
type ProbeResult = {
  path: string; label: string; method?: string; ok: boolean; status: number | null;
  latencyMs: number; error: string | null;
  bodySnippet?: string | null; attempts?: Attempt[]; retriedCount?: number;
};
type AuditResponse = {
  ok: boolean; configured: boolean; upstreamUrl: string | null;
  issues: string[]; reachable: boolean; results: ProbeResult[];
  failingCount: number;
  config?: { timeoutMs: number; maxRetries: number; baseDelayMs: number };
  lastOkAt: number | null; lastErrorAt: number | null;
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [timeoutMs, setTimeoutMs] = useState(3500);
  const [maxRetries, setMaxRetries] = useState(1);
  const [autoRefreshSec, setAutoRefreshSec] = useState(0); // 0 = off

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const qs = new URLSearchParams({ timeoutMs: String(timeoutMs), maxRetries: String(maxRetries) });
      const r = await fetch(`/api/pluto/audit?${qs}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`audit endpoint returned HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [timeoutMs, maxRetries]);

  useEffect(() => {
    if (!autoRefreshSec) return;
    const id = setInterval(() => { void load(); }, autoRefreshSec * 1000);
    return () => clearInterval(id);
  }, [autoRefreshSec, load]);

  useEffect(() => { void load(); }, [load]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const okAll = data?.ok ?? false;
  return (
    <section className="rounded-lg border border-border bg-card p-4" data-testid="backend-audit-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Backend health audit</h2>
          {data && (
            <span
              data-testid="audit-status-badge"
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                okAll ? "bg-green-500/15 text-green-500" : "bg-red-500/15 text-red-500"
              }`}
            >
              {okAll ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
              {okAll ? "healthy" : `${data.failingCount} failing`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            timeout
            <input
              type="number" min={200} max={15000} step={100} value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value) || 3500)}
              className="w-16 rounded border border-border bg-background px-1 py-0.5 text-[10px]"
              aria-label="timeout ms"
            />ms
          </label>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            retries
            <input
              type="number" min={0} max={4} step={1} value={maxRetries}
              onChange={(e) => setMaxRetries(Number(e.target.value) || 0)}
              className="w-12 rounded border border-border bg-background px-1 py-0.5 text-[10px]"
              aria-label="max retries"
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            auto
            <select
              value={autoRefreshSec}
              onChange={(e) => setAutoRefreshSec(Number(e.target.value))}
              className="rounded border border-border bg-background px-1 py-0.5 text-[10px]"
              aria-label="auto refresh interval"
              data-testid="audit-auto-refresh"
            >
              <option value={0}>off</option>
              <option value={5}>5s</option>
              <option value={15}>15s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
            </select>
          </label>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Re-check
          </button>
        </div>
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
            <div className="mb-2 rounded-md border border-border/60 bg-muted/30 p-2 text-[11px]" data-testid="audit-last-failure">
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
                  <th className="px-2 py-1 text-center font-medium">Retries</th>
                  <th className="px-2 py-1 text-left font-medium">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {data.results.map((r) => {
                  const isOpen = expanded.has(r.path);
                  const hasDetails = (r.attempts && r.attempts.length > 0) || r.bodySnippet || r.error;
                  return (
                    <Fragment key={r.path}>
                      <tr
                        className={`${r.ok ? "" : "bg-red-500/5"} ${hasDetails ? "cursor-pointer hover:bg-accent/40" : ""}`}
                        onClick={() => hasDetails && toggle(r.path)}
                        data-testid={`audit-row-${r.path}`}
                      >
                        <td className="px-2 py-1">
                          <div className="flex items-center gap-1 font-medium">
                            {hasDetails ? (isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />) : <span className="w-3" />}
                            {r.label}
                          </div>
                          <div className="pl-4 font-mono text-muted-foreground">{r.method ? `${r.method} ` : ""}{r.path}</div>
                        </td>
                        <td className="px-2 py-1">
                          <span className={r.ok ? "text-green-500" : "text-red-500"}>
                            {r.ok ? "OK" : "FAIL"}{r.status != null ? ` · ${r.status}` : ""}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{r.latencyMs}ms</td>
                        <td className="px-2 py-1 text-center tabular-nums text-muted-foreground">{r.retriedCount ?? 0}</td>
                        <td className="px-2 py-1 text-red-400">{r.error ?? ""}</td>
                      </tr>
                      {isOpen && hasDetails && (
                        <tr className="bg-muted/20" data-testid={`audit-detail-${r.path}`}>
                          <td colSpan={5} className="px-3 py-2">
                            {r.attempts && r.attempts.length > 0 && (
                              <div className="mb-2">
                                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Attempts</div>
                                <table className="w-full text-[10px]">
                                  <thead className="text-muted-foreground">
                                    <tr>
                                      <th className="px-1 py-0.5 text-left">#</th>
                                      <th className="px-1 py-0.5 text-left">Result</th>
                                      <th className="px-1 py-0.5 text-right">Status</th>
                                      <th className="px-1 py-0.5 text-right">Latency</th>
                                      <th className="px-1 py-0.5 text-right">Backoff</th>
                                      <th className="px-1 py-0.5 text-left">Error</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {r.attempts.map((a) => (
                                      <tr key={a.attempt}>
                                        <td className="px-1 py-0.5 tabular-nums">{a.attempt}</td>
                                        <td className={`px-1 py-0.5 ${a.ok ? "text-green-500" : "text-red-500"}`}>{a.ok ? "ok" : "fail"}</td>
                                        <td className="px-1 py-0.5 text-right tabular-nums">{a.status ?? "—"}</td>
                                        <td className="px-1 py-0.5 text-right tabular-nums text-muted-foreground">{a.latencyMs}ms</td>
                                        <td className="px-1 py-0.5 text-right tabular-nums text-muted-foreground">{a.waitedMs}ms</td>
                                        <td className="px-1 py-0.5 font-mono text-red-400">{a.error ?? ""}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            {r.bodySnippet && (
                              <div>
                                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Response body</div>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border/60 bg-black/40 p-2 font-mono text-[10px] text-red-200">{r.bodySnippet}</pre>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {data.results.length === 0 && (
                  <tr><td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">
                    Upstream not configured — nothing to probe.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Checked {fmtAgo(data.checkedAt)}. {data.config ? `timeout ${data.config.timeoutMs}ms · retries ${data.config.maxRetries} · base backoff ${data.config.baseDelayMs}ms.` : ""}
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
