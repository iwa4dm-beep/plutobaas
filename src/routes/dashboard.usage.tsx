import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Save, Activity, ShieldAlert, Radio, Lock, Bell, Webhook, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import {
  isLive, usage, me,
  type UsageMetric, type UsageSummary, type Quota,
  type OverageBehavior, type UsageEnvironment, type WorkspaceRole,
  type QuotaAlert, type UsageWebhook,
} from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/usage")({ component: UsagePage });

// Phase 22b — Live SSE-driven usage dashboard with workspace-role RBAC.
// Non-admins see read-only cards; admins can edit quotas / billing labels.

const METRICS: { key: UsageMetric; label: string; unit: string }[] = [
  { key: "storage_gb", label: "Storage", unit: "GB" },
  { key: "egress_gb", label: "Egress", unit: "GB" },
  { key: "function_invocations", label: "Function invocations", unit: "calls" },
  { key: "ai_tokens", label: "AI tokens", unit: "tokens" },
  { key: "db_rows", label: "DB rows written", unit: "rows" },
  { key: "realtime_msgs", label: "Realtime messages", unit: "msgs" },
];

const ENVS: UsageEnvironment[] = ["production", "staging", "preview", "development"];
const OVERAGES: OverageBehavior[] = ["allow", "warn", "block"];

type Draft = { hard: string; soft: string; overage: OverageBehavior; label: string; alertPct: string };

function UsagePage() {
  const [period, setPeriod] = useState<"day" | "month">("month");
  const [env, setEnv] = useState<UsageEnvironment | "">("");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [quotas, setQuotas] = useState<Record<string, Quota>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [connected, setConnected] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [role, setRole] = useState<WorkspaceRole>("member");
  const canAdmin = role === "owner" || role === "admin" ||
                   role === "global_admin" || role === "service_role";
  const [alerts, setAlerts] = useState<QuotaAlert[]>([]);
  const [webhooks, setWebhooks] = useState<UsageWebhook[]>([]);
  const [newHookUrl, setNewHookUrl] = useState("");
  const [newHookSecret, setNewHookSecret] = useState("");

  const loadAlerts = useCallback(async () => {
    if (!isLive()) return;
    try { const r = await usage.alerts(true); setAlerts(r.alerts); } catch { /* ignore */ }
  }, []);
  const loadWebhooks = useCallback(async () => {
    if (!isLive()) return;
    try { const r = await usage.webhooks(); setWebhooks(r.webhooks); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void loadAlerts(); const t = setInterval(loadAlerts, 15_000); return () => clearInterval(t); }, [loadAlerts]);
  useEffect(() => { void loadWebhooks(); }, [loadWebhooks]);

  // Merge quotas from either REST (fallback) or the SSE snapshot into UI state.
  const applyQuotas = useCallback((rows: Quota[]) => {
    const map: Record<string, Quota> = {};
    const dr: Record<string, Draft> = {};
    for (const qu of rows) {
      map[qu.metric] = qu;
      dr[qu.metric] = {
        hard: String(qu.hard_limit),
        soft: qu.soft_limit == null ? "" : String(qu.soft_limit),
        overage: qu.overage_behavior ?? "warn",
        label: qu.billing_label ?? "",
        alertPct: qu.alert_pct == null ? "" : String(qu.alert_pct),
      };
    }
    setQuotas(map);
    setDrafts((d) => ({ ...dr, ...d }));
  }, []);

  const loadOnce = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [s, q] = await Promise.all([
        usage.summary(period, env || undefined),
        usage.quotas(),
      ]);
      setSummary(s);
      applyQuotas(q.quotas);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [period, env, applyQuotas]);

  // Load caller's workspace role once so we know which controls to enable.
  useEffect(() => {
    if (!isLive()) return;
    me.workspaceRole().then((r) => setRole(r.role)).catch(() => setRole("anon"));
  }, []);

  // Live SSE stream — replaces the previous 15s polling loop.
  useEffect(() => {
    if (!isLive() || !live) { setConnected(false); void loadOnce(); return; }
    setConnected(false);
    const unsub = usage.stream(
      (payload) => {
        setConnected(true);
        setLastAt(payload.ts ?? Date.now());
        setSummary({ period: payload.period, environment: payload.environment, metrics: payload.metrics });
        if (payload.quotas) applyQuotas(payload.quotas);
      },
      { period, environment: env || undefined, onError: (e) => { setConnected(false); setErr(e.message); } },
    );
    return () => { setConnected(false); unsub(); };
  }, [period, env, live, loadOnce, applyQuotas]);

  const saveQuota = async (metric: UsageMetric) => {
    if (!canAdmin) { setErr("Only workspace admins can edit quotas."); return; }
    const d = drafts[metric]; if (!d) return;
    const hard = Number(d.hard); if (!isFinite(hard) || hard < 0) return;
    const soft = d.soft === "" ? undefined : Number(d.soft);
    const alertPct = d.alertPct === "" ? undefined : Number(d.alertPct);
    setSavingKey(metric);
    try {
      await usage.setQuota({
        metric, period, hard_limit: hard,
        soft_limit: soft,
        overage_behavior: d.overage,
        billing_label: d.label || undefined,
        alert_pct: alertPct,
      });
      if (!live) await loadOnce();
    } catch (e) { setErr((e as Error).message); }
    finally { setSavingKey(null); }
  };

  const seedTest = async () => {
    try {
      await usage.record({
        metric: "function_invocations",
        quantity: 1,
        environment: env || "production",
        billing_label: "dashboard-test",
        meta: { source: "dashboard-test" },
      });
    } catch (e) { setErr((e as Error).message); }
  };

  const totalCards = useMemo(() => METRICS.length, []);
  void totalCards;


  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Usage & Quotas"
        description="Track metered usage per workspace and enforce soft/hard quotas with environment-aware billing labels." />
      {!isLive() && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
          Set <code>VITE_PLUTO_URL</code> to a running Pluto instance to see live usage.
        </div>
      )}
      {alerts.length > 0 && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs space-y-2">
          <div className="flex items-center gap-2 font-medium text-red-600 dark:text-red-400">
            <Bell className="h-4 w-4" /> {alerts.length} active quota alert{alerts.length > 1 ? "s" : ""}
          </div>
          {alerts.slice(0, 5).map(a => (
            <div key={a.id} className="flex items-center justify-between gap-2">
              <span><strong>{a.metric}</strong> at {Number(a.pct).toFixed(1)}% ({a.used.toLocaleString(undefined, { maximumFractionDigits: 2 })}/{a.hard_limit ?? "∞"}) · {new Date(a.triggered_at).toLocaleString()}</span>
              {canAdmin && (
                <button className="text-[11px] px-2 py-0.5 border border-border rounded hover:bg-background"
                        onClick={async () => { await usage.resolveAlert(a.id); void loadAlerts(); }}>Resolve</button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {(["day", "month"] as const).map((p) => (
          <button key={p} onClick={() => setPeriod(p)}
            className={`text-xs px-3 py-1 rounded border ${period === p ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}>
            Last {p === "day" ? "24h" : "30d"}
          </button>
        ))}
        <select value={env} onChange={(e) => setEnv(e.target.value as UsageEnvironment | "")}
          className="text-xs bg-background border border-border rounded px-2 py-1">
          <option value="">All environments</option>
          {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <button onClick={() => void loadOnce()} className="text-xs inline-flex items-center gap-1 border border-border rounded px-3 py-1">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
        <label className="text-[11px] inline-flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          <Radio className={`h-3 w-3 ${connected ? "text-emerald-500" : "text-muted-foreground"}`} />
          {connected ? "Streaming" : live ? "Connecting…" : "Paused"}
          {lastAt && connected && <span className="text-[10px] text-muted-foreground">· {new Date(lastAt).toLocaleTimeString()}</span>}
        </label>
        <span className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground inline-flex items-center gap-1">
          {canAdmin ? "workspace admin" : <><Lock className="h-3 w-3" /> read-only ({role})</>}
        </span>
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
          const behavior = bucket?.overage_behavior ?? "warn";
          const label = bucket?.billing_label ?? "";
          const byEnv = bucket?.by_env ?? {};
          const byLabel = bucket?.by_label ?? {};
          const pct  = hard && hard > 0 ? Math.min(100, (used / hard) * 100) : 0;
          const softPct = hard && soft ? Math.min(100, (soft / hard) * 100) : null;
          const draft = drafts[m.key] ?? {
            hard: hard == null ? "" : String(hard),
            soft: soft == null ? "" : String(soft),
            overage: behavior, label, alertPct: "",
          };
          const over = hard != null && used > hard;
          const nearSoft = soft != null && used >= soft;
          return (
            <div key={m.key} className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium flex items-center gap-1">
                    {m.label}
                    {over && draft.overage === "block" && <ShieldAlert className="h-3 w-3 text-red-500" />}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{m.unit} · {period === "day" ? "24h" : "30d"}{env && ` · ${env}`}</div>
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
                {hard != null ? `${used.toFixed(2)} / ${hard} ${m.unit}` : "no quota set"} {soft != null && `· soft ${soft}`} · {draft.overage}
              </div>

              {Object.keys(byEnv).length > 0 && (
                <div className="flex flex-wrap gap-1 text-[10px]">
                  {Object.entries(byEnv).map(([k, v]) => (
                    <span key={k} className="border border-border rounded px-1.5 py-0.5">
                      {k}: {v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  ))}
                </div>
              )}
              {Object.keys(byLabel).length > 0 && (
                <div className="flex flex-wrap gap-1 text-[10px]">
                  {Object.entries(byLabel).slice(0, 6).map(([k, v]) => (
                    <span key={k} className="border border-border rounded px-1.5 py-0.5 bg-muted/40">
                      {k}: {v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-[1fr_1fr] gap-1 items-center pt-1">
                <input value={draft.hard} disabled={!canAdmin} onChange={(e) => setDrafts((d) => ({ ...d, [m.key]: { ...draft, hard: e.target.value } }))}
                  placeholder="hard limit" className="bg-background border border-border rounded px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed" />
                <input value={draft.soft} disabled={!canAdmin} onChange={(e) => setDrafts((d) => ({ ...d, [m.key]: { ...draft, soft: e.target.value } }))}
                  placeholder="soft" className="bg-background border border-border rounded px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed" />
              </div>
              <input value={draft.alertPct} disabled={!canAdmin}
                onChange={(e) => setDrafts((d) => ({ ...d, [m.key]: { ...draft, alertPct: e.target.value } }))}
                placeholder="alert at % (default 80)" className="w-full bg-background border border-border rounded px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed" />
              <div className="grid grid-cols-[1fr_1fr_auto] gap-1 items-center">
                <select value={draft.overage} disabled={!canAdmin}
                  onChange={(e) => setDrafts((d) => ({ ...d, [m.key]: { ...draft, overage: e.target.value as OverageBehavior } }))}
                  className="bg-background border border-border rounded px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                  {OVERAGES.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input value={draft.label} disabled={!canAdmin}
                  onChange={(e) => setDrafts((d) => ({ ...d, [m.key]: { ...draft, label: e.target.value } }))}
                  placeholder="billing label" className="bg-background border border-border rounded px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed" />
                <button onClick={() => void saveQuota(m.key)} disabled={savingKey === m.key || !canAdmin}
                  title={canAdmin ? "Save quota" : "Workspace admin required"}
                  className="text-xs inline-flex items-center gap-1 bg-primary text-primary-foreground rounded px-2 py-1 disabled:opacity-40">
                  {savingKey === m.key ? <Loader2 className="h-3 w-3 animate-spin" /> : canAdmin ? <Save className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground space-y-1">
        <div className="text-sm text-foreground font-medium mb-1">Overage behavior</div>
        <p><strong>allow</strong> — record and permit; <strong>warn</strong> — record, flag, still permit; <strong>block</strong> — deny further actions until reset or quota bump. Billing labels group usage per subsystem (e.g. <code>storage:avatars</code>, <code>fn:image-resize</code>).</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="text-sm font-medium flex items-center gap-2"><Webhook className="h-4 w-4" /> Alert webhooks</div>
        <p className="text-xs text-muted-foreground">POSTed with a <code>x-pluto-signature</code> HMAC-SHA256 header when a quota crosses its alert threshold.</p>
        {canAdmin && (
          <div className="flex gap-2">
            <input value={newHookUrl} onChange={e => setNewHookUrl(e.target.value)} placeholder="https://example.com/webhook"
                   className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs" />
            <input value={newHookSecret} onChange={e => setNewHookSecret(e.target.value)} placeholder="signing secret (optional)" type="password"
                   className="w-48 bg-background border border-border rounded px-2 py-1 text-xs" />
            <button
              className="text-xs inline-flex items-center gap-1 bg-primary text-primary-foreground rounded px-3 py-1 disabled:opacity-40"
              disabled={!newHookUrl.trim()}
              onClick={async () => {
                try {
                  await usage.createWebhook({ url: newHookUrl.trim(), secret: newHookSecret || undefined });
                  setNewHookUrl(""); setNewHookSecret(""); void loadWebhooks();
                } catch (e) { setErr((e as Error).message); }
              }}>Add</button>
          </div>
        )}
        <div className="space-y-1">
          {webhooks.map(h => (
            <div key={h.id} className="flex items-center justify-between text-xs p-2 border border-border rounded-md">
              <div>
                <div className="font-mono truncate max-w-[420px]">{h.url}</div>
                <div className="text-[10px] text-muted-foreground">
                  events: {h.events.join(",")} · last: {h.last_status ?? "—"}
                  {h.last_error && <span className="text-destructive"> · {h.last_error}</span>}
                </div>
              </div>
              {canAdmin && (
                <button onClick={async () => { await usage.deleteWebhook(h.id); void loadWebhooks(); }}
                        className="p-1 border border-border rounded hover:bg-background"><Trash2 className="h-3 w-3" /></button>
              )}
            </div>
          ))}
          {webhooks.length === 0 && <div className="text-xs text-muted-foreground">No webhooks configured.</div>}
        </div>
      </div>
    </div>
  );
}

