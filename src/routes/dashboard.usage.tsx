import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save, Activity } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, usage, type UsageMetric, type UsageSummary, type Quota } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/usage")({ component: UsagePage });

// Phase 21 — Metered usage dashboard.
// Reads /usage/v1/summary (aggregated from public.usage_events) and lets
// admins set per-workspace quotas. Soft-limit is shown as a warning band,
// hard-limit as the ceiling.

const METRICS: { key: UsageMetric; label: string; unit: string }[] = [
  { key: "storage_gb", label: "Storage", unit: "GB" },
  { key: "egress_gb", label: "Egress", unit: "GB" },
  { key: "function_invocations", label: "Function invocations", unit: "calls" },
  { key: "ai_tokens", label: "AI tokens", unit: "tokens" },
  { key: "db_rows", label: "DB rows written", unit: "rows" },
  { key: "realtime_msgs", label: "Realtime messages", unit: "msgs" },
];

function UsagePage() {
  const [period, setPeriod] = useState<"day" | "month">("month");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [quotas, setQuotas] = useState<Record<string, Quota>>({});
  const [drafts, setDrafts] = useState<Record<string, { hard: string; soft: string }>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [s, q] = await Promise.all([usage.summary(period), usage.quotas()]);
      setSummary(s);
      const map: Record<string, Quota> = {};
      const dr: Record<string, { hard: string; soft: string }> = {};
      for (const qu of q.quotas) {
        map[qu.metric] = qu;
        dr[qu.metric] = { hard: String(qu.hard_limit), soft: qu.soft_limit == null ? "" : String(qu.soft_limit) };
      }
      setQuotas(map); setDrafts((d) => ({ ...dr, ...d }));
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [period]);
  useEffect(() => { void load(); }, [load]);

  const saveQuota = async (metric: UsageMetric) => {
    const d = drafts[metric]; if (!d) return;
    const hard = Number(d.hard); if (!isFinite(hard) || hard < 0) return;
    const soft = d.soft === "" ? undefined : Number(d.soft);
    setSavingKey(metric);
    try {
      await usage.setQuota({ metric, period, hard_limit: hard, soft_limit: soft });
      await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setSavingKey(null); }
  };

  const seedTest = async () => {
    try {
      await usage.record({ metric: "function_invocations", quantity: 1, meta: { source: "dashboard-test" } });
      await load();
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Usage & Quotas"
        description="Track metered usage per workspace and enforce soft/hard quotas across storage, egress, function invocations, and AI tokens." />
      {!isLive() && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
          Set <code>VITE_PLUTO_URL</code> to a running Pluto instance to see live usage.
        </div>
      )}
      <div className="flex items-center gap-2">
        {(["day", "month"] as const).map((p) => (
          <button key={p} onClick={() => setPeriod(p)}
            className={`text-xs px-3 py-1 rounded border ${period === p ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}>
            Last {p === "day" ? "24h" : "30d"}
          </button>
        ))}
        <button onClick={() => void load()} className="text-xs inline-flex items-center gap-1 border border-border rounded px-3 py-1">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
        <button onClick={() => void seedTest()} className="text-xs inline-flex items-center gap-1 border border-border rounded px-3 py-1 ml-auto">
          <Activity className="h-3 w-3" /> Record test event
        </button>
      </div>
      {err && <div className="text-xs text-red-500">{err}</div>}
      {loading && <div className="text-xs text-muted-foreground inline-flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</div>}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {METRICS.map((m) => {
          const bucket = summary?.metrics[m.key];
          const used = bucket?.used ?? 0;
          const hard = bucket?.hard_limit ?? null;
          const soft = bucket?.soft_limit ?? null;
          const pct  = hard && hard > 0 ? Math.min(100, (used / hard) * 100) : 0;
          const softPct = hard && soft ? Math.min(100, (soft / hard) * 100) : null;
          const draft = drafts[m.key] ?? { hard: hard == null ? "" : String(hard), soft: soft == null ? "" : String(soft) };
          const over = hard != null && used > hard;
          const nearSoft = soft != null && used >= soft;
          return (
            <div key={m.key} className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="text-[11px] text-muted-foreground">{m.unit} · {period === "day" ? "24h window" : "30d window"}</div>
                </div>
                <div className={`text-lg font-semibold tabular-nums ${over ? "text-red-500" : nearSoft ? "text-yellow-500" : ""}`}>
                  {used.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                </div>
              </div>
              <div className="relative h-2 rounded bg-muted overflow-hidden">
                <div className={`h-full ${over ? "bg-red-500" : nearSoft ? "bg-yellow-500" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                {softPct != null && (
                  <div className="absolute top-0 h-full w-px bg-yellow-500/60" style={{ left: `${softPct}%` }} />
                )}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {hard != null ? `${used.toFixed(2)} / ${hard} ${m.unit}` : "no quota set"} {soft != null && `· soft ${soft}`}
              </div>
              <div className="grid grid-cols-[1fr_1fr_auto] gap-1 items-center pt-1">
                <input value={draft.hard} onChange={(e) => setDrafts((d) => ({ ...d, [m.key]: { ...draft, hard: e.target.value } }))}
                  placeholder="hard limit" className="bg-background border border-border rounded px-2 py-1 text-xs" />
                <input value={draft.soft} onChange={(e) => setDrafts((d) => ({ ...d, [m.key]: { ...draft, soft: e.target.value } }))}
                  placeholder="soft" className="bg-background border border-border rounded px-2 py-1 text-xs" />
                <button onClick={() => void saveQuota(m.key)} disabled={savingKey === m.key}
                  className="text-xs inline-flex items-center gap-1 bg-primary text-primary-foreground rounded px-2 py-1 disabled:opacity-40">
                  {savingKey === m.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground space-y-1">
        <div className="text-sm text-foreground font-medium mb-1">How ingestion works</div>
        <p>Server modules (storage, functions, AI) should call <code>POST /usage/v1/events</code> after each billable action, e.g. <code>{`{ metric: "ai_tokens", quantity: 1234 }`}</code>. Quotas are enforced by reading aggregates and comparing against <code>public.workspace_quotas</code>. Both tables are workspace-scoped via RLS.</p>
      </div>
    </div>
  );
}
