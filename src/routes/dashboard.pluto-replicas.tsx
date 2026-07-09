import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardPlutoReplicasHelp } from "@/content/help/dashboard.pluto-replicas";

export const Route = createFileRoute("/dashboard/pluto-replicas")({
  component: ReplicasPage,
  head: () => ({ meta: [{ title: "Pluto Read Replicas" }] }),
});

function ReplicasPage() {
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ region: "", label: "", connection_url: "", weight: 100, enabled: true });
  const [routed, setRouted] = useState<any | null>(null);
  const [routeReq, setRouteReq] = useState({ region: "", max_lag_seconds: 5 });
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!projectId) return;
    try { setRows(await plutoApi(`/admin/v1/replicas?project_id=${projectId}`)); setErr(null); }
    catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function addReplica() {
    try {
      await plutoApi("/admin/v1/replicas", { method: "POST", body: JSON.stringify({ project_id: projectId, ...form, weight: Number(form.weight) }) });
      pushUiHistory({ action: "replica.upsert", detail: form.label, ok: true });
      setForm({ region: "", label: "", connection_url: "", weight: 100, enabled: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function probe(id: string) { try { await plutoApi(`/admin/v1/replicas/${id}/probe`, { method: "POST" }); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function probeAll() { try { await plutoApi("/admin/v1/replicas/probe-all", { method: "POST", body: JSON.stringify({ project_id: projectId }) }); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function del(id: string) { if (!confirm("Delete replica?")) return; try { await plutoApi(`/admin/v1/replicas/${id}`, { method: "DELETE" }); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function route() {
    try {
      const body: any = { project_id: projectId };
      if (routeReq.region) body.region = routeReq.region;
      if (routeReq.max_lag_seconds) body.max_lag_seconds = Number(routeReq.max_lag_seconds);
      setRouted(await plutoApi("/admin/v1/replicas/route", { method: "POST", body: JSON.stringify(body) }));
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Multi-region Read Replicas</h1>
      <HelpPanel help={dashboardPlutoReplicasHelp} />
      {err && <div className="rounded-md bg-destructive/10 text-destructive p-3 text-sm">{err}</div>}
      <input className="border rounded px-2 py-1 bg-background w-full" placeholder="Project ID" value={projectId} onChange={(e) => setProjectId(e.target.value)} />

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Register replica</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <input className="border rounded px-2 py-1 bg-background" placeholder="region" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background col-span-2" placeholder="postgres://…" value={form.connection_url} onChange={(e) => setForm({ ...form, connection_url: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" type="number" placeholder="weight" value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} />
        </div>
        <div className="flex gap-2">
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={addReplica}>Save</button>
          <button className="border rounded px-3 py-1" onClick={probeAll}>Probe all</button>
        </div>
      </section>

      <section className="rounded-md border border-border p-4">
        <h2 className="font-medium mb-2">Replicas</h2>
        <table className="text-sm w-full">
          <thead><tr className="text-left text-muted-foreground"><th>Region</th><th>Label</th><th>Weight</th><th>Healthy</th><th>Lag (s / bytes)</th><th>Last check</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.region}</td><td>{r.label}</td><td>{r.weight}</td>
                <td className={r.healthy === false ? "text-destructive" : r.healthy ? "text-green-500" : ""}>{r.healthy === null || r.healthy === undefined ? "—" : String(r.healthy)}</td>
                <td>{r.lag_seconds ?? "—"} / {r.lag_bytes ?? "—"}</td>
                <td>{r.last_health_at ? new Date(r.last_health_at).toLocaleTimeString() : "—"}</td>
                <td className="text-right space-x-2"><button className="underline" onClick={() => probe(r.id)}>probe</button><button className="text-destructive" onClick={() => del(r.id)}>delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Routing hint</h2>
        <div className="flex gap-2">
          <input className="border rounded px-2 py-1 bg-background" placeholder="prefer region" value={routeReq.region} onChange={(e) => setRouteReq({ ...routeReq, region: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background w-32" type="number" placeholder="max lag s" value={routeReq.max_lag_seconds} onChange={(e) => setRouteReq({ ...routeReq, max_lag_seconds: Number(e.target.value) })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={route}>Pick replica</button>
        </div>
        {routed && <pre className="text-xs bg-muted rounded p-2 overflow-auto">{JSON.stringify(routed, null, 2)}</pre>}
      </section>
    </div>
  );
}
