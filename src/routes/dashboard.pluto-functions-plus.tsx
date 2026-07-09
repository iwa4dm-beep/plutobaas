import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-functions-plus")({
  component: FunctionsPlus,
  head: () => ({ meta: [{ title: "Pluto Functions (Cron, Secrets, Logs)" }] }),
});

function FunctionsPlus() {
  const [projectId, setProjectId] = useState("");
  const [slug, setSlug] = useState("");
  const [secrets, setSecrets] = useState<any[]>([]);
  const [cron, setCron] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [newSec, setNewSec] = useState({ name: "", value: "" });
  const [newCron, setNewCron] = useState({ cron_expr: "*/5 * * * *", payload: "{}" });
  const [level, setLevel] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!projectId) return;
    try {
      setCron(await plutoApi(`/functions/v1/cron?project_id=${projectId}`));
      if (slug) setSecrets(await plutoApi(`/functions/v1/secrets?project_id=${projectId}&function_slug=${slug}`));
      const qs = new URLSearchParams({ project_id: projectId, limit: "200" });
      if (slug) qs.set("function_slug", slug);
      if (level) qs.set("level", level);
      setLogs(await plutoApi(`/functions/v1/logs?${qs}`));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId, slug, level]);

  async function addSecret() {
    try {
      await plutoApi("/functions/v1/secrets", { method: "POST", body: JSON.stringify({ project_id: projectId, function_slug: slug, name: newSec.name, value: newSec.value }) });
      pushUiHistory({ action: "function.secret.upsert", detail: `${slug}:${newSec.name}`, ok: true });
      setNewSec({ name: "", value: "" });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function addCron() {
    try {
      const payload = JSON.parse(newCron.payload || "{}");
      await plutoApi("/functions/v1/cron", { method: "POST", body: JSON.stringify({ project_id: projectId, function_slug: slug, cron_expr: newCron.cron_expr, payload }) });
      pushUiHistory({ action: "function.cron.create", detail: `${slug} ${newCron.cron_expr}`, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function toggleCron(id: string, enabled: boolean) {
    try { await plutoApi(`/functions/v1/cron/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !enabled }) }); await refresh(); }
    catch (e: any) { setErr(e.message); }
  }
  async function delCron(id: string) {
    if (!confirm("Delete this schedule?")) return;
    try { await plutoApi(`/functions/v1/cron/${id}`, { method: "DELETE" }); await refresh(); }
    catch (e: any) { setErr(e.message); }
  }
  async function delSecret(id: string) {
    if (!confirm("Delete this secret?")) return;
    try { await plutoApi(`/functions/v1/secrets/${id}`, { method: "DELETE" }); await refresh(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Edge Functions — Cron, Secrets, Logs</h1>
      <AutoHelpPanel slug={'dashboard.pluto-functions-plus'} title={'Edge Functions — Cron, Secrets, Logs'} description={''} />
      {err && <div className="rounded-md bg-destructive/10 text-destructive p-3 text-sm">{err}</div>}

      <div className="flex gap-2">
        <input className="border rounded px-2 py-1 bg-background flex-1" placeholder="Project ID" value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        <input className="border rounded px-2 py-1 bg-background" placeholder="function slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </div>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Cron schedules</h2>
        <div className="flex gap-2 flex-wrap">
          <input className="border rounded px-2 py-1 bg-background font-mono" value={newCron.cron_expr} onChange={(e) => setNewCron({ ...newCron, cron_expr: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background flex-1" placeholder='payload JSON' value={newCron.payload} onChange={(e) => setNewCron({ ...newCron, payload: e.target.value })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={addCron} disabled={!slug}>Schedule</button>
        </div>
        <ul className="text-sm space-y-1">
          {cron.map((c) => (
            <li key={c.id} className="flex justify-between">
              <span><code>{c.cron_expr}</code> → {c.function_slug} · next {c.next_run_at ? new Date(c.next_run_at).toLocaleString() : "—"} {!c.enabled && <em>(disabled)</em>}</span>
              <span className="flex gap-2">
                <button className="underline" onClick={() => toggleCron(c.id, c.enabled)}>{c.enabled ? "Disable" : "Enable"}</button>
                <button className="text-destructive" onClick={() => delCron(c.id)}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Secrets for <code>{slug || "…"}</code></h2>
        <div className="flex gap-2">
          <input className="border rounded px-2 py-1 bg-background font-mono w-40" placeholder="NAME" value={newSec.name} onChange={(e) => setNewSec({ ...newSec, name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background flex-1" placeholder="value" value={newSec.value} onChange={(e) => setNewSec({ ...newSec, value: e.target.value })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={addSecret} disabled={!slug || !newSec.name}>Save</button>
        </div>
        <ul className="text-sm">
          {secrets.map((s) => (
            <li key={s.id} className="flex justify-between"><span>{s.name}</span><button className="text-destructive text-xs" onClick={() => delSecret(s.id)}>Delete</button></li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4">
        <div className="flex justify-between items-center mb-2">
          <h2 className="font-medium">Logs</h2>
          <select className="border rounded px-2 py-1 bg-background text-sm" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">all levels</option><option>debug</option><option>info</option><option>warn</option><option>error</option>
          </select>
        </div>
        <div className="max-h-96 overflow-auto font-mono text-xs space-y-1">
          {logs.map((l) => (
            <div key={l.id} className={l.level === "error" ? "text-destructive" : l.level === "warn" ? "text-yellow-500" : "text-muted-foreground"}>
              [{new Date(l.logged_at).toLocaleTimeString()}] {l.level.toUpperCase()} · {l.function_slug} · {l.message} {l.duration_ms != null && `(${l.duration_ms}ms)`}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
