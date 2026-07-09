import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-marketplace")({
  component: MarketplacePage,
  head: () => ({ meta: [{ title: "Pluto Marketplace & Extensions" }] }),
});

function MarketplacePage() {
  const [projectId, setProjectId] = useState("");
  const [category, setCategory] = useState<string>("");
  const [q, setQ] = useState("");
  const [registry, setRegistry] = useState<any[]>([]);
  const [installed, setInstalled] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [selEvent, setSelEvent] = useState<string>("");
  const [dispatch, setDispatch] = useState({ event: "audit.custom", payload: "{}" });
  const [publish, setPublish] = useState({ slug: "", name: "", description: "", category: "plugin", version: "0.1.0", manifest: "{}" });
  const [err, setErr] = useState<string | null>(null);

  async function loadRegistry() {
    try {
      const qs = new URLSearchParams();
      if (category) qs.set("category", category);
      if (q) qs.set("q", q);
      setRegistry(await plutoApi(`/admin/v1/marketplace/extensions?${qs}`));
    } catch (e: any) { setErr(e.message); }
  }
  async function loadInstalled() {
    if (!projectId) return;
    try { setInstalled(await plutoApi(`/admin/v1/marketplace/installed?project_id=${projectId}`)); } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void loadRegistry(); }, [category]);
  useEffect(() => { void loadInstalled(); }, [projectId]);

  async function install(slug: string) {
    try {
      await plutoApi("/admin/v1/marketplace/install", { method: "POST", body: JSON.stringify({ project_id: projectId, slug, config: {} }) });
      pushUiHistory({ action: "marketplace.install", detail: slug, ok: true });
      await loadInstalled(); await loadRegistry();
    } catch (e: any) { setErr(e.message); }
  }
  async function toggle(inst: any) {
    try {
      await plutoApi(`/admin/v1/marketplace/installed/${inst.id}`, { method: "PATCH", body: JSON.stringify({ status: inst.status === "active" ? "disabled" : "active" }) });
      await loadInstalled();
    } catch (e: any) { setErr(e.message); }
  }
  async function updateConfig(inst: any) {
    const raw = prompt("Config JSON", JSON.stringify(inst.config)); if (!raw) return;
    try { await plutoApi(`/admin/v1/marketplace/installed/${inst.id}`, { method: "PATCH", body: JSON.stringify({ config: JSON.parse(raw) }) }); await loadInstalled(); } catch (e: any) { setErr(e.message); }
  }
  async function uninstall(id: string) {
    if (!confirm("Uninstall?")) return;
    try { await plutoApi(`/admin/v1/marketplace/installed/${id}`, { method: "DELETE" }); await loadInstalled(); } catch (e: any) { setErr(e.message); }
  }
  async function doDispatch() {
    try {
      const r = await plutoApi<any>("/admin/v1/marketplace/dispatch", { method: "POST", body: JSON.stringify({ project_id: projectId, event: dispatch.event, payload: JSON.parse(dispatch.payload || "{}") }) });
      alert(`Fired ${r.fired}/${r.hooks} webhooks`);
    } catch (e: any) { setErr(e.message); }
  }
  async function loadEvents(peid: string) { setSelEvent(peid); try { setEvents(await plutoApi(`/admin/v1/marketplace/events?project_extension_id=${peid}`)); } catch (e: any) { setErr(e.message); } }
  async function doPublish() {
    try { await plutoApi("/admin/v1/marketplace/extensions", { method: "POST", body: JSON.stringify({ ...publish, manifest: JSON.parse(publish.manifest || "{}") }) }); setPublish({ slug: "", name: "", description: "", category: "plugin", version: "0.1.0", manifest: "{}" }); await loadRegistry(); } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Marketplace & Extensions</h1>
      <AutoHelpPanel slug={'dashboard.pluto-marketplace'} title={'Marketplace & Extensions'} description={''} />
        <p className="text-sm text-muted-foreground">Plugins, templates, starters, and webhook-plugins.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input className="border rounded px-3 py-2 text-sm w-80" placeholder="project_id (for install/dispatch)" value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        <select className="border rounded px-3 py-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          <option value="plugin">plugin</option>
          <option value="template">template</option>
          <option value="starter">starter</option>
          <option value="webhook">webhook</option>
        </select>
        <input className="border rounded px-3 py-2 text-sm" placeholder="search" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={loadRegistry}>Search</button>
      </div>
      {err && <div className="text-sm text-destructive">{err}</div>}

      <section>
        <h2 className="font-medium mb-2">Registry ({registry.length})</h2>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {registry.map((e) => (
            <div key={e.id} className="border rounded-lg p-3 space-y-1">
              <div className="flex items-center justify-between">
                <div className="font-medium text-sm">{e.name}{e.is_official && <span className="ml-2 text-[10px] rounded bg-primary/10 text-primary px-1">official</span>}</div>
                <span className="text-xs text-muted-foreground">{e.category}</span>
              </div>
              <div className="text-xs text-muted-foreground">{e.description}</div>
              <div className="text-xs text-muted-foreground">v{e.version} · {e.install_count} installs</div>
              <button className="mt-2 px-2 py-1 text-xs rounded bg-primary text-primary-foreground disabled:opacity-40" disabled={!projectId} onClick={() => install(e.slug)}>Install</button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-medium mb-2">Installed on this project</h2>
        <table className="w-full text-sm border rounded overflow-hidden">
          <thead className="bg-muted"><tr><th className="text-left px-2 py-1">Name</th><th>Category</th><th>Version</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {installed.map((i) => (
              <tr key={i.id} className="border-t">
                <td className="px-2 py-1">{i.name}</td>
                <td className="text-center">{i.category}</td>
                <td className="text-center">{i.version}</td>
                <td className="text-center">{i.status}</td>
                <td className="text-right space-x-2 pr-2">
                  <button className="underline" onClick={() => toggle(i)}>{i.status === "active" ? "Disable" : "Enable"}</button>
                  <button className="underline" onClick={() => updateConfig(i)}>Config</button>
                  <button className="underline" onClick={() => loadEvents(i.id)}>Events</button>
                  <button className="underline text-destructive" onClick={() => uninstall(i.id)}>Uninstall</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {selEvent && (
          <div className="mt-2 border rounded p-2 max-h-64 overflow-auto">
            {events.map((e) => <div key={e.id} className="text-xs font-mono">{new Date(e.at).toISOString()} · {e.event} · {e.status}</div>)}
          </div>
        )}
      </section>

      <section className="border rounded-lg p-4 space-y-2">
        <h2 className="font-medium">Dispatch event (test webhook-plugins)</h2>
        <div className="flex gap-2">
          <input className="border rounded px-3 py-2 text-sm w-64" placeholder="event name" value={dispatch.event} onChange={(e) => setDispatch({ ...dispatch, event: e.target.value })} />
          <input className="border rounded px-3 py-2 text-sm flex-1 font-mono" placeholder='payload JSON' value={dispatch.payload} onChange={(e) => setDispatch({ ...dispatch, payload: e.target.value })} />
          <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={doDispatch}>Dispatch</button>
        </div>
      </section>

      <section className="border rounded-lg p-4 space-y-2">
        <h2 className="font-medium">Publish extension</h2>
        <div className="grid grid-cols-2 gap-2">
          <input className="border rounded px-3 py-2 text-sm" placeholder="slug" value={publish.slug} onChange={(e) => setPublish({ ...publish, slug: e.target.value })} />
          <input className="border rounded px-3 py-2 text-sm" placeholder="name" value={publish.name} onChange={(e) => setPublish({ ...publish, name: e.target.value })} />
          <input className="border rounded px-3 py-2 text-sm col-span-2" placeholder="description" value={publish.description} onChange={(e) => setPublish({ ...publish, description: e.target.value })} />
          <select className="border rounded px-3 py-2 text-sm" value={publish.category} onChange={(e) => setPublish({ ...publish, category: e.target.value })}>
            <option value="plugin">plugin</option><option value="template">template</option><option value="starter">starter</option><option value="webhook">webhook</option>
          </select>
          <input className="border rounded px-3 py-2 text-sm" placeholder="version" value={publish.version} onChange={(e) => setPublish({ ...publish, version: e.target.value })} />
          <textarea className="border rounded px-3 py-2 text-sm col-span-2 font-mono h-24" placeholder="manifest JSON" value={publish.manifest} onChange={(e) => setPublish({ ...publish, manifest: e.target.value })} />
        </div>
        <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={doPublish}>Publish</button>
      </section>
    </div>
  );
}
