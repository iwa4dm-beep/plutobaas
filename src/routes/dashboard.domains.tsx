import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Plus, Trash2, Globe } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { isLive, live, type AllowedOrigin } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/domains")({
  head: () => ({
    meta: [
      { title: "Domains — Pluto" },
      { name: "description", content: "Manage the browser-facing domains that can call your Pluto API." },
    ],
  }),
  component: DomainsPage,
});

type Project = { id: string; name?: string; slug?: string };

function DomainsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [items, setItems] = useState<AllowedOrigin[]>([]);
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isLive()) return;
    void (async () => {
      try {
        const raw: any = await (live as any).admin?.projects?.() ??
          await fetch("/api/pluto/admin/v1/projects").then((r) => r.json()).catch(() => []);
        const list = Array.isArray(raw) ? raw : (raw?.items ?? []);
        setProjects(list);
        if (list.length && !projectId) setProjectId(list[0].id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!projectId) return;
    void refresh();
  }, [projectId]);

  async function refresh() {
    if (!projectId) return;
    try {
      const { items } = await live.admin.domains.list(projectId);
      setItems(items);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function add() {
    if (!origin.trim() || !projectId) return;
    setBusy(true);
    try {
      await live.admin.domains.add(projectId, origin.trim());
      setOrigin("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!projectId) return;
    if (!confirm("Remove this domain? Browsers on this origin will no longer be able to call your API.")) return;
    try { await live.admin.domains.remove(projectId, id); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Domains"
        description="Add every website that will call your API from a browser. Changes apply within seconds — no restart."
      />
      <AutoHelpPanel slug={'dashboard.domains'} title={'Domains'} description={'Add every website that will call your API from a browser. Changes apply within seconds — no restart.'} />

      {!isLive() && (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Live backend not configured. Set <code>VITE_PLUTO_URL</code> to manage domains.
        </div>
      )}

      {isLive() && projects.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">Project</label>
          <select value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name ?? p.slug ?? p.id}</option>
            ))}
          </select>
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <div className="text-sm font-medium flex items-center gap-1.5"><Globe className="h-4 w-4" /> Add a domain</div>
        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          <input value={origin} onChange={(e) => setOrigin(e.target.value)}
            placeholder="https://app.example.com"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm" />
          <button onClick={add} disabled={busy || !origin.trim() || !projectId}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        <p className="text-xs text-muted-foreground">Bare origin only — scheme + host + optional port. No paths.</p>
      </div>

      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div>}

      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Origin</th>
              <th className="px-3 py-2">Note</th>
              <th className="px-3 py-2">Added</th>
              <th className="px-3 py-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">
                No domains yet. Add one above so your website can talk to the API.
              </td></tr>
            )}
            {items.map((o) => (
              <tr key={o.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{o.origin}</td>
                <td className="px-3 py-2 text-xs">{(o as any).description ?? o.note ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{new Date(o.created_at).toLocaleString()}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => remove(o.id)} className="rounded-md p-1.5 hover:bg-destructive/10 hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
