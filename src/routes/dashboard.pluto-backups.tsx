import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-backups")({
  component: BackupsPage,
  head: () => ({ meta: [{ title: "Pluto Backups & Restore" }] }),
});

function BackupsPage() {
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<"full" | "schema" | "data">("full");
  const [cron, setCron] = useState("0 3 * * *");

  async function refresh() {
    if (!projectId) return;
    try {
      const [b, s] = await Promise.all([
        plutoApi<any[]>(`/admin/v1/backups?project_id=${projectId}`),
        plutoApi<any[]>(`/admin/v1/backup-schedules?project_id=${projectId}`),
      ]);
      setRows(b); setSchedules(s); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function createBackup() {
    setBusy(true);
    try {
      await plutoApi(`/admin/v1/backups`, { method: "POST", body: JSON.stringify({ project_id: projectId, kind }) });
      pushUiHistory({ action: "backup.create", detail: kind, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); pushUiHistory({ action: "backup.create", ok: false }); }
    finally { setBusy(false); }
  }
  async function restore(id: string) {
    if (!confirm("Restore will overwrite the database. Continue?")) return;
    setBusy(true);
    try {
      await plutoApi(`/admin/v1/backups/${id}/restore`, { method: "POST", headers: { "X-Pluto-Confirm": "RESTORE" } });
      pushUiHistory({ action: "backup.restore", detail: id, ok: true });
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function addSchedule() {
    try {
      await plutoApi(`/admin/v1/backup-schedules`, {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, cron_expr: cron, kind, retention_days: 14 }),
      });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function deleteSchedule(id: string) {
    await plutoApi(`/admin/v1/backup-schedules/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Backups & Restore</h1>
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{err}</div>}

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-xs">Project ID
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[320px]" placeholder="uuid" />
        </label>
        <label className="flex flex-col text-xs">Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as any)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm">
            <option value="full">Full</option>
            <option value="schema">Schema only</option>
            <option value="data">Data only</option>
          </select>
        </label>
        <button disabled={!projectId || busy} onClick={createBackup}
          className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">
          Create backup
        </button>
        <button onClick={refresh} className="rounded-md border text-sm px-3 py-2">Refresh</button>
      </div>

      <section>
        <h2 className="text-sm font-medium mb-2">Backups</h2>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr><th className="text-left p-2">ID</th><th>Kind</th><th>Status</th><th>Size</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 font-mono text-xs">{r.id.slice(0, 8)}</td>
                  <td className="text-center">{r.kind}</td>
                  <td className="text-center">{r.status}</td>
                  <td className="text-center">{r.size_bytes ? `${(r.size_bytes / 1024 / 1024).toFixed(1)} MB` : "—"}</td>
                  <td className="text-center text-xs">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="p-2 text-right space-x-2">
                    {r.status === "succeeded" && (
                      <>
                        <a href={`${localStorage.getItem("pluto.upstream.url")}/admin/v1/backups/${r.id}/download`}
                           target="_blank" rel="noreferrer" className="text-primary underline text-xs">Download</a>
                        <button onClick={() => restore(r.id)} className="text-destructive text-xs underline">Restore</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-muted-foreground text-sm">No backups</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium mb-2">Schedules</h2>
        <div className="flex gap-2 items-end mb-2">
          <label className="flex flex-col text-xs">Cron
            <input value={cron} onChange={(e) => setCron(e.target.value)}
              className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[200px]" />
          </label>
          <button disabled={!projectId} onClick={addSchedule} className="rounded-md border text-sm px-3 py-2">Add schedule</button>
        </div>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr><th className="text-left p-2">Cron</th><th>Kind</th><th>Retention</th><th>Enabled</th><th></th></tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="p-2 font-mono text-xs">{s.cron_expr}</td>
                  <td className="text-center">{s.kind}</td>
                  <td className="text-center">{s.retention_days}d</td>
                  <td className="text-center">{s.enabled ? "✓" : "—"}</td>
                  <td className="p-2 text-right">
                    <button onClick={() => deleteSchedule(s.id)} className="text-destructive text-xs underline">Delete</button>
                  </td>
                </tr>
              ))}
              {schedules.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground text-sm">No schedules</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
