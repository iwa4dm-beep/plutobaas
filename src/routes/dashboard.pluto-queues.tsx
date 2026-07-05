import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-queues")({
  component: QueuesPage,
  head: () => ({ meta: [{ title: "Pluto Queues & Jobs" }] }),
});

function QueuesPage() {
  const [projectId, setProjectId] = useState("");
  const [queues, setQueues] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [form, setForm] = useState({ name: "", max_concurrency: 5, visibility_sec: 30, max_attempts: 5 });
  const [enq, setEnq] = useState({ queue_id: "", payload: "{}" });
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!projectId) return;
    try {
      setQueues(await plutoApi(`/admin/v1/queues?project_id=${projectId}`));
      const qs = new URLSearchParams({ project_id: projectId, limit: "200" });
      if (statusFilter) qs.set("status", statusFilter);
      setJobs(await plutoApi(`/admin/v1/jobs?${qs}`));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId, statusFilter]);

  async function createQueue() {
    try {
      await plutoApi("/admin/v1/queues", { method: "POST", body: JSON.stringify({ project_id: projectId, ...form }) });
      pushUiHistory({ action: "queue.upsert", detail: form.name, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function enqueue() {
    try {
      await plutoApi("/admin/v1/jobs", { method: "POST", body: JSON.stringify({ queue_id: enq.queue_id, payload: JSON.parse(enq.payload || "{}") }) });
      pushUiHistory({ action: "job.enqueue", detail: enq.queue_id, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function requeue(id: string) { await plutoApi(`/admin/v1/jobs/${id}/requeue`, { method: "POST" }); await refresh(); }
  async function sweep() { const r = await plutoApi<any>("/admin/v1/jobs/sweep", { method: "POST" }); alert(`Reclaimed ${r.reclaimed}`); await refresh(); }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Queues & Background Jobs</h1>
      {err && <div className="rounded-md bg-destructive/10 text-destructive p-3 text-sm">{err}</div>}
      <input className="border rounded px-2 py-1 bg-background w-full" placeholder="Project ID" value={projectId} onChange={(e) => setProjectId(e.target.value)} />

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Create queue</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <input className="border rounded px-2 py-1 bg-background" placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label className="text-xs">concurrency <input className="border rounded w-16 px-1 bg-background" type="number" value={form.max_concurrency} onChange={(e) => setForm({ ...form, max_concurrency: Number(e.target.value) })} /></label>
          <label className="text-xs">vis(s) <input className="border rounded w-16 px-1 bg-background" type="number" value={form.visibility_sec} onChange={(e) => setForm({ ...form, visibility_sec: Number(e.target.value) })} /></label>
          <label className="text-xs">max att <input className="border rounded w-16 px-1 bg-background" type="number" value={form.max_attempts} onChange={(e) => setForm({ ...form, max_attempts: Number(e.target.value) })} /></label>
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={createQueue}>Save</button>
        </div>
        <ul className="text-sm space-y-1">
          {queues.map((q) => (
            <li key={q.id}>
              <button className="underline" onClick={() => setEnq({ ...enq, queue_id: q.id })}>{q.name}</button>
              <span className="text-xs text-muted-foreground ml-2">pending {q.pending} · dlq {q.dlq} · conc {q.max_concurrency}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Enqueue job</h2>
        <div className="flex gap-2">
          <input className="border rounded px-2 py-1 bg-background w-72" placeholder="queue_id" value={enq.queue_id} onChange={(e) => setEnq({ ...enq, queue_id: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background flex-1 font-mono" placeholder="payload JSON" value={enq.payload} onChange={(e) => setEnq({ ...enq, payload: e.target.value })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={enqueue}>Enqueue</button>
        </div>
      </section>

      <section className="rounded-md border border-border p-4">
        <div className="flex justify-between items-center mb-2">
          <h2 className="font-medium">Jobs</h2>
          <div className="flex gap-2">
            <select className="border rounded px-2 py-1 bg-background text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">all</option><option>pending</option><option>claimed</option><option>succeeded</option><option>failed</option><option>dlq</option>
            </select>
            <button className="border rounded px-3 py-1 text-sm" onClick={sweep}>Sweep expired</button>
          </div>
        </div>
        <ul className="text-xs font-mono space-y-1 max-h-96 overflow-auto">
          {jobs.map((j) => (
            <li key={j.id} className="flex justify-between">
              <span>{j.status} · att {j.attempts}/{j.max_attempts} · {j.last_error?.slice(0, 80) ?? ""}</span>
              {j.status === "dlq" && <button className="underline" onClick={() => requeue(j.id)}>requeue</button>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
