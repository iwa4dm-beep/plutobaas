import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-billing")({
  component: BillingPage,
  head: () => ({ meta: [{ title: "Pluto Billing, Usage & Alerts" }] }),
});

function BillingPage() {
  const [projectId, setProjectId] = useState("");
  const [data, setData] = useState<{ period: string; usage: any[]; quotas: any[] } | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [quotaForm, setQuotaForm] = useState({ metric: "api.requests", soft_limit: 100000, hard_limit: 200000, window: "month" as const });
  const [alertForm, setAlertForm] = useState({
    name: "", metric: "pluto_http_requests_total", operator: ">" as const, threshold: 1000,
    window_seconds: 300, channel: "email" as const, target: "",
  });

  async function refresh() {
    if (!projectId) return;
    try {
      const [u, a] = await Promise.all([
        plutoApi<any>(`/admin/v1/usage?project_id=${projectId}`),
        plutoApi<any[]>(`/admin/v1/alerts?project_id=${projectId}`),
      ]);
      setData(u); setAlerts(a); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function saveQuota() {
    try {
      await plutoApi(`/admin/v1/quotas`, { method: "POST", body: JSON.stringify({ project_id: projectId, ...quotaForm }) });
      pushUiHistory({ action: "quota.upsert", detail: quotaForm.metric, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function createAlert() {
    try {
      await plutoApi(`/admin/v1/alerts`, { method: "POST", body: JSON.stringify({ project_id: projectId, ...alertForm }) });
      pushUiHistory({ action: "alert.create", detail: alertForm.name, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function delAlert(id: string) {
    if (!confirm("Delete alert rule?")) return;
    await plutoApi(`/admin/v1/alerts/${id}`, { method: "DELETE" });
    await refresh();
  }
  async function toggleAlert(a: any) {
    await plutoApi(`/admin/v1/alerts/${a.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }) });
    await refresh();
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Billing, Usage & Alerts</h1>
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{err}</div>}

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-xs">Project ID
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[320px]" placeholder="uuid" />
        </label>
        <button onClick={refresh} className="rounded-md border text-sm px-3 py-2">Refresh</button>
        <a href={`${typeof window !== "undefined" ? localStorage.getItem("pluto.upstream.url") ?? "" : ""}/metrics`}
           target="_blank" rel="noreferrer" className="text-xs underline text-primary ml-2">Prometheus /metrics</a>
      </div>

      <section>
        <h2 className="text-sm font-medium mb-2">Usage — {data?.period ?? "—"}</h2>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr><th className="text-left p-2">Metric</th><th>Period</th><th>Value</th><th>Soft limit</th><th>Hard limit</th></tr>
            </thead>
            <tbody>
              {(data?.usage ?? []).map((u: any) => {
                const q = data?.quotas.find((q: any) => q.metric === u.metric);
                return (
                  <tr key={u.metric + u.period} className="border-t">
                    <td className="p-2 font-mono text-xs">{u.metric}</td>
                    <td className="text-center text-xs">{u.period}</td>
                    <td className="text-right font-medium">{Number(u.value).toLocaleString()}</td>
                    <td className="text-right text-xs">{q?.soft_limit?.toLocaleString() ?? "—"}</td>
                    <td className="text-right text-xs">{q?.hard_limit?.toLocaleString() ?? "—"}</td>
                  </tr>
                );
              })}
              {(!data || data.usage.length === 0) && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground text-sm">No usage yet</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-md border p-4 space-y-2">
        <h2 className="text-sm font-medium">Set quota</h2>
        <div className="grid grid-cols-4 gap-2">
          <input placeholder="metric" value={quotaForm.metric} onChange={(e) => setQuotaForm({ ...quotaForm, metric: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <input type="number" placeholder="soft" value={quotaForm.soft_limit} onChange={(e) => setQuotaForm({ ...quotaForm, soft_limit: parseInt(e.target.value || "0") })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <input type="number" placeholder="hard" value={quotaForm.hard_limit} onChange={(e) => setQuotaForm({ ...quotaForm, hard_limit: parseInt(e.target.value || "0") })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <select value={quotaForm.window} onChange={(e) => setQuotaForm({ ...quotaForm, window: e.target.value as any })} className="rounded-md border bg-background px-3 py-1.5 text-sm">
            <option value="month">month</option><option value="day">day</option>
          </select>
        </div>
        <button onClick={saveQuota} disabled={!projectId} className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">Save quota</button>
      </section>

      <section className="rounded-md border p-4 space-y-2">
        <h2 className="text-sm font-medium">New alert rule</h2>
        <div className="grid grid-cols-3 gap-2">
          <input placeholder="name" value={alertForm.name} onChange={(e) => setAlertForm({ ...alertForm, name: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <input placeholder="metric" value={alertForm.metric} onChange={(e) => setAlertForm({ ...alertForm, metric: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <select value={alertForm.operator} onChange={(e) => setAlertForm({ ...alertForm, operator: e.target.value as any })} className="rounded-md border bg-background px-3 py-1.5 text-sm">
            {[">", ">=", "<", "<=", "="].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <input type="number" placeholder="threshold" value={alertForm.threshold} onChange={(e) => setAlertForm({ ...alertForm, threshold: parseFloat(e.target.value || "0") })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <input type="number" placeholder="window sec" value={alertForm.window_seconds} onChange={(e) => setAlertForm({ ...alertForm, window_seconds: parseInt(e.target.value || "0") })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <select value={alertForm.channel} onChange={(e) => setAlertForm({ ...alertForm, channel: e.target.value as any })} className="rounded-md border bg-background px-3 py-1.5 text-sm">
            <option value="email">email</option><option value="webhook">webhook</option>
          </select>
        </div>
        <input placeholder="target (email or webhook URL)" value={alertForm.target} onChange={(e) => setAlertForm({ ...alertForm, target: e.target.value })} className="w-full rounded-md border bg-background px-3 py-1.5 text-sm" />
        <button onClick={createAlert} disabled={!projectId || !alertForm.name || !alertForm.target} className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">Create alert</button>
      </section>

      <section>
        <h2 className="text-sm font-medium mb-2">Alert rules</h2>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr><th className="text-left p-2">Name</th><th>Metric</th><th>Rule</th><th>Channel</th><th>Enabled</th><th></th></tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="p-2">{a.name}</td>
                  <td className="font-mono text-xs">{a.metric}</td>
                  <td className="text-center text-xs">{a.operator} {a.threshold} / {a.window_seconds}s</td>
                  <td className="text-center text-xs">{a.channel}</td>
                  <td className="text-center">
                    <button onClick={() => toggleAlert(a)} className="text-xs underline">{a.enabled ? "✓ on" : "off"}</button>
                  </td>
                  <td className="p-2 text-right">
                    <button onClick={() => delAlert(a.id)} className="text-destructive text-xs underline">Delete</button>
                  </td>
                </tr>
              ))}
              {alerts.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-muted-foreground text-sm">No alert rules</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
