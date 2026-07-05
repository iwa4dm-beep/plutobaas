import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live, type AllowedOrigin } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/cors")({
  head: () => ({
    meta: [
      { title: "CORS whitelist — Pluto BaaS" },
      { name: "description", content: "Manage the allowed origins that can call the Pluto API from the browser." },
    ],
  }),
  component: CorsPage,
});

function CorsPage() {
  const [items, setItems] = useState<AllowedOrigin[]>([]);
  const [origin, setOrigin] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!isLive()) return;
    try {
      const { items } = await live.admin.cors.list();
      setItems(items);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function add() {
    if (!origin.trim()) return;
    setBusy(true);
    try {
      await live.admin.cors.add(origin.trim(), note ? { note } : undefined);
      setOrigin(""); setNote("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm("Remove this origin? Browsers on this origin will no longer be able to call the API.")) return;
    try { await live.admin.cors.remove(id); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="CORS whitelist"
        description="Only these origins can call the API from a browser. localhost is auto-allowed in dev."
      />


      {!isLive() && (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Set <code>VITE_PLUTO_URL</code> and <code>VITE_PLUTO_SERVICE_KEY</code> to manage live rules.
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <div className="text-sm font-medium">Add an origin</div>
        <div className="grid gap-2 md:grid-cols-[2fr_2fr_auto]">
          <input
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="https://app.example.com"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={add}
            disabled={busy || !origin.trim() || !isLive()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Bare origin only — scheme + host + optional port. Path, trailing slash, or wildcards are rejected.
        </p>
      </div>

      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div>}

      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Origin</th>
              <th className="px-3 py-2">Workspace</th>
              <th className="px-3 py-2">Note</th>
              <th className="px-3 py-2">Added</th>
              <th className="px-3 py-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">
                No origins configured. Production browsers will be blocked until you add one.
              </td></tr>
            )}
            {items.map((o) => (
              <tr key={o.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{o.origin}</td>
                <td className="px-3 py-2 text-xs">{o.workspace_id ?? <span className="text-muted-foreground">global</span>}</td>
                <td className="px-3 py-2 text-xs">{o.note ?? "—"}</td>
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
