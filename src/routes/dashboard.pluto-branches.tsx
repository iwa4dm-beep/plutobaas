import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-branches")({
  component: BranchesPage,
  head: () => ({ meta: [{ title: "Pluto Database Branches" }] }),
});

function BranchesPage() {
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", parent_branch: "main", git_ref: "" });
  const [diff, setDiff] = useState<any | null>(null);

  async function refresh() {
    if (!projectId) return;
    try { setRows(await plutoApi(`/admin/v1/branches?project_id=${projectId}`)); setErr(null); }
    catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function create() {
    try {
      await plutoApi(`/admin/v1/branches`, { method: "POST", body: JSON.stringify({ project_id: projectId, ...form }) });
      pushUiHistory({ action: "branch.create", detail: form.name, ok: true });
      setForm({ name: "", parent_branch: "main", git_ref: "" });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function showDiff(id: string) {
    try { setDiff(await plutoApi(`/admin/v1/branches/${id}/diff`)); }
    catch (e: any) { setErr(e.message); }
  }
  async function promote(id: string) {
    if (!confirm("Promote this branch to production? This is destructive.")) return;
    try {
      await plutoApi(`/admin/v1/branches/${id}/promote`, { method: "POST", headers: { "X-Pluto-Confirm": "PROMOTE" } });
      pushUiHistory({ action: "branch.promote", detail: id, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function archive(id: string) {
    if (!confirm("Delete/archive branch and drop database?")) return;
    await plutoApi(`/admin/v1/branches/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Database Branches</h1>
      <AutoHelpPanel slug={'dashboard.pluto-branches'} title={'Database Branches'} description={''} />
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{err}</div>}
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-xs">Project ID
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[320px]" placeholder="uuid" />
        </label>
        <button onClick={refresh} className="rounded-md border text-sm px-3 py-2">Refresh</button>
      </div>

      <section className="rounded-md border p-4 space-y-2">
        <h2 className="text-sm font-medium">Create branch</h2>
        <div className="grid grid-cols-3 gap-2">
          <input placeholder="branch name (e.g. preview/feature-x)" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <input placeholder="parent (main)" value={form.parent_branch}
            onChange={(e) => setForm({ ...form, parent_branch: e.target.value })}
            className="rounded-md border bg-background px-3 py-1.5 text-sm" />
          <input placeholder="git ref (optional)" value={form.git_ref}
            onChange={(e) => setForm({ ...form, git_ref: e.target.value })}
            className="rounded-md border bg-background px-3 py-1.5 text-sm" />
        </div>
        <button disabled={!projectId || !form.name} onClick={create}
          className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">
          Create branch
        </button>
      </section>

      <section>
        <h2 className="text-sm font-medium mb-2">Branches</h2>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr><th className="text-left p-2">Name</th><th>Parent</th><th>DB</th><th>Status</th><th>Git</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 font-mono text-xs">{r.name}</td>
                  <td className="text-center text-xs">{r.parent_branch}</td>
                  <td className="text-xs font-mono">{r.db_name}</td>
                  <td className="text-center">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${r.status === "ready" ? "bg-green-500/20" : r.status === "failed" ? "bg-red-500/20" : "bg-muted"}`}>{r.status}</span>
                  </td>
                  <td className="text-xs">{r.git_ref ?? "—"}</td>
                  <td className="text-xs">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="p-2 text-right space-x-2 text-xs">
                    <button onClick={() => showDiff(r.id)} className="underline">Diff</button>
                    <button onClick={() => promote(r.id)} className="underline">Promote</button>
                    <button onClick={() => archive(r.id)} className="text-destructive underline">Archive</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-muted-foreground text-sm">No branches</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {diff && (
        <section className="rounded-md border p-3">
          <h3 className="text-sm font-medium mb-2">Diff summary</h3>
          <pre className="bg-muted/40 p-2 text-xs rounded overflow-auto">{JSON.stringify(diff, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
