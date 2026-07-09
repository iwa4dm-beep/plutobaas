import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-webhooks")({
  component: WebhooksPage,
  head: () => ({ meta: [{ title: "Pluto Webhooks & Event Triggers" }] }),
});

const EVENTS = [
  "row.inserted", "row.updated", "row.deleted",
  "auth.user.created", "auth.user.deleted",
  "storage.object.created", "storage.object.deleted",
  "function.invoked", "function.failed",
];

function WebhooksPage() {
  const [projectId, setProjectId] = useState("");
  const [subs, setSubs] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [minted, setMinted] = useState<{ secret: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [form, setForm] = useState({ name: "", target_url: "", events: ["row.inserted"] as string[] });

  async function refresh() {
    if (!projectId) return;
    try {
      const list = await plutoApi<any[]>(`/admin/v1/webhooks?project_id=${projectId}`);
      setSubs(list); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function loadDeliveries(id: string) {
    setSelected(id);
    try { setDeliveries(await plutoApi<any[]>(`/admin/v1/webhooks/${id}/deliveries`)); }
    catch (e: any) { setErr(e.message); }
  }

  async function create() {
    try {
      const res = await plutoApi<any>(`/admin/v1/webhooks`, {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, ...form }),
      });
      setMinted({ secret: res.secret });
      pushUiHistory({ action: "webhook.create", detail: form.name, ok: true });
      setForm({ name: "", target_url: "", events: ["row.inserted"] });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }

  async function rotate(id: string) {
    if (!confirm("Rotate signing secret? Old secret stops working immediately.")) return;
    const res = await plutoApi<any>(`/admin/v1/webhooks/${id}/rotate`, { method: "POST" });
    setMinted({ secret: res.secret });
    pushUiHistory({ action: "webhook.rotate", detail: id, ok: true });
  }
  async function del(id: string) {
    if (!confirm("Delete webhook?")) return;
    await plutoApi(`/admin/v1/webhooks/${id}`, { method: "DELETE" });
    await refresh();
  }
  async function sendTest(id: string) {
    try {
      const r = await plutoApi<any>(`/admin/v1/webhooks/${id}/test`, { method: "POST" });
      alert(`Status: ${r.status}\nHTTP: ${r.response_status ?? "—"}\nDuration: ${r.duration_ms}ms`);
      if (selected === id) await loadDeliveries(id);
    } catch (e: any) { setErr(e.message); }
  }
  async function retry(id: string, subId: string) {
    await plutoApi(`/admin/v1/deliveries/${id}/retry`, { method: "POST" });
    await loadDeliveries(subId);
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Webhooks & Event Triggers</h1>
      <AutoHelpPanel slug={'dashboard.pluto-webhooks'} title={'Webhooks & Event Triggers'} description={''} />
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{err}</div>}
      {minted && (
        <div className="rounded-md border-2 border-primary p-4 bg-primary/5 space-y-2">
          <div className="font-medium">Signing secret (shown once)</div>
          <code className="block bg-background p-2 rounded text-xs break-all">{minted.secret}</code>
          <button onClick={() => setMinted(null)} className="text-xs underline">I have saved this secret</button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-xs">Project ID
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[320px]" placeholder="uuid" />
        </label>
        <button onClick={refresh} className="rounded-md border text-sm px-3 py-2">Refresh</button>
      </div>

      <section className="rounded-md border p-4 space-y-2">
        <h2 className="font-medium text-sm">New subscription</h2>
        <div className="grid grid-cols-2 gap-3">
          <input placeholder="Name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <input placeholder="https://example.com/hook" value={form.target_url}
            onChange={(e) => setForm({ ...form, target_url: e.target.value })}
            className="rounded-md border bg-background px-3 py-1.5 text-sm" />
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-1 rounded-full border px-2 py-1">
              <input type="checkbox" checked={form.events.includes(ev)}
                onChange={(e) => setForm({ ...form,
                  events: e.target.checked ? [...form.events, ev] : form.events.filter((x) => x !== ev),
                })} />
              {ev}
            </label>
          ))}
        </div>
        <button disabled={!projectId || !form.name || !form.target_url} onClick={create}
          className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">
          Create webhook
        </button>
      </section>

      <section>
        <h2 className="text-sm font-medium mb-2">Subscriptions</h2>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr><th className="text-left p-2">Name</th><th>URL</th><th>Events</th><th>Enabled</th><th></th></tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="p-2">{s.name}</td>
                  <td className="text-xs truncate max-w-[280px]">{s.target_url}</td>
                  <td className="text-xs">{s.events.join(", ")}</td>
                  <td className="text-center">{s.enabled ? "✓" : "—"}</td>
                  <td className="p-2 text-right space-x-2 text-xs">
                    <button onClick={() => loadDeliveries(s.id)} className="underline">Deliveries</button>
                    <button onClick={() => sendTest(s.id)} className="underline">Test</button>
                    <button onClick={() => rotate(s.id)} className="underline">Rotate</button>
                    <button onClick={() => del(s.id)} className="text-destructive underline">Delete</button>
                  </td>
                </tr>
              ))}
              {subs.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground text-sm">No subscriptions</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <section>
          <h2 className="text-sm font-medium mb-2">Deliveries for {selected.slice(0, 8)}</h2>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr><th className="text-left p-2">Event</th><th>Status</th><th>HTTP</th><th>Attempt</th><th>Duration</th><th>Created</th><th></th></tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-t">
                    <td className="p-2">{d.event_type}</td>
                    <td className="text-center">{d.status}</td>
                    <td className="text-center">{d.response_status ?? "—"}</td>
                    <td className="text-center">{d.attempt}</td>
                    <td className="text-center">{d.duration_ms ?? "—"}ms</td>
                    <td className="text-xs">{new Date(d.created_at).toLocaleString()}</td>
                    <td className="p-2 text-right">
                      {(d.status === "failed" || d.status === "dead") && (
                        <button onClick={() => retry(d.id, selected)} className="text-xs underline">Retry</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
