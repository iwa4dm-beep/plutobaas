import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-ai")({
  component: AIPage,
  head: () => ({ meta: [{ title: "Pluto AI Gateway & Embeddings" }] }),
});

function AIPage() {
  const [projectId, setProjectId] = useState("");
  const [keys, setKeys] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [costs, setCosts] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [newKey, setNewKey] = useState({ provider: "lovable", name: "default", api_key: "", base_url: "" });
  const [embed, setEmbed] = useState({ schema_name: "public", table_name: "", source_column: "content", target_column: "embedding", model: "google/gemini-embedding-001", limit: 200 });
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!projectId) return;
    try {
      setKeys(await plutoApi(`/ai/v1/keys?project_id=${projectId}`));
      setLogs(await plutoApi(`/ai/v1/logs?project_id=${projectId}&limit=100`));
      setCosts(await plutoApi(`/ai/v1/costs?project_id=${projectId}&days=7`));
      setJobs(await plutoApi(`/ai/v1/embed-jobs?project_id=${projectId}&limit=100`));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function addKey() {
    try {
      await plutoApi("/ai/v1/keys", { method: "POST", body: JSON.stringify({ project_id: projectId, ...newKey, base_url: newKey.base_url || undefined }) });
      pushUiHistory({ action: "ai.key.upsert", detail: `${newKey.provider}:${newKey.name}`, ok: true });
      setNewKey({ ...newKey, api_key: "" });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function delKey(id: string) {
    if (!confirm("Delete this key?")) return;
    try { await plutoApi(`/ai/v1/keys/${id}`, { method: "DELETE" }); await refresh(); }
    catch (e: any) { setErr(e.message); }
  }
  async function enqueueEmbed() {
    try {
      const r = await plutoApi<any>("/ai/v1/embed-jobs/enqueue", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, ...embed, limit: Number(embed.limit) }),
      });
      pushUiHistory({ action: "ai.embed.enqueue", detail: `${embed.table_name}:${embed.target_column}`, ok: true });
      alert(`Enqueued ${r.created}/${r.scanned}`);
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function runTick() {
    try {
      const r = await plutoApi<any>("/ai/v1/embed-jobs/tick", { method: "POST", body: JSON.stringify({ project_id: projectId, batch: 10 }) });
      alert(`Processed ${r.processed} (done ${r.done}, failed ${r.failed})`);
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">AI Gateway & Embeddings</h1>
      {err && <div className="rounded-md bg-destructive/10 text-destructive p-3 text-sm">{err}</div>}
      <input className="border rounded px-2 py-1 bg-background w-full" placeholder="Project ID" value={projectId} onChange={(e) => setProjectId(e.target.value)} />

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Provider keys</h2>
        <div className="flex gap-2 flex-wrap">
          <select className="border rounded px-2 py-1 bg-background" value={newKey.provider} onChange={(e) => setNewKey({ ...newKey, provider: e.target.value })}>
            <option>lovable</option><option>openai</option><option>anthropic</option><option>google</option><option>openrouter</option><option>custom</option>
          </select>
          <input className="border rounded px-2 py-1 bg-background" placeholder="name" value={newKey.name} onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background flex-1" placeholder="api key" value={newKey.api_key} onChange={(e) => setNewKey({ ...newKey, api_key: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background w-48" placeholder="base_url (optional)" value={newKey.base_url} onChange={(e) => setNewKey({ ...newKey, base_url: e.target.value })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={addKey}>Save</button>
        </div>
        <ul className="text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex justify-between"><span>{k.provider} · {k.name}{k.base_url && ` · ${k.base_url}`}</span><button className="text-destructive text-xs" onClick={() => delKey(k.id)}>Delete</button></li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Embedding jobs</h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          <input className="border rounded px-2 py-1 bg-background" placeholder="schema" value={embed.schema_name} onChange={(e) => setEmbed({ ...embed, schema_name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="table" value={embed.table_name} onChange={(e) => setEmbed({ ...embed, table_name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="source col" value={embed.source_column} onChange={(e) => setEmbed({ ...embed, source_column: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="target col" value={embed.target_column} onChange={(e) => setEmbed({ ...embed, target_column: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="model" value={embed.model} onChange={(e) => setEmbed({ ...embed, model: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" type="number" placeholder="limit" value={embed.limit} onChange={(e) => setEmbed({ ...embed, limit: Number(e.target.value) })} />
        </div>
        <div className="flex gap-2">
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={enqueueEmbed} disabled={!embed.table_name}>Enqueue backfill</button>
          <button className="border rounded px-3 py-1" onClick={runTick}>Run tick (10)</button>
        </div>
        <ul className="text-xs font-mono max-h-64 overflow-auto space-y-1">
          {jobs.map((j) => (<li key={j.id}>{j.status} · {j.schema_name}.{j.table_name}.{j.target_column} · att {j.attempts} · {j.last_error?.slice(0, 80) ?? ""}</li>))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4">
        <h2 className="font-medium mb-2">Cost breakdown (7d)</h2>
        <table className="text-sm w-full">
          <thead><tr className="text-left text-muted-foreground"><th>Model</th><th>Op</th><th>Calls</th><th>In</th><th>Out</th><th>Cost USD</th></tr></thead>
          <tbody>
            {costs.map((c, i) => (<tr key={i}><td>{c.model}</td><td>{c.operation}</td><td>{c.calls}</td><td>{c.input_tokens}</td><td>{c.output_tokens}</td><td>${Number(c.cost_usd ?? 0).toFixed(4)}</td></tr>))}
          </tbody>
        </table>
      </section>

      <section className="rounded-md border border-border p-4">
        <h2 className="font-medium mb-2">Recent calls</h2>
        <ul className="text-xs font-mono max-h-72 overflow-auto space-y-1">
          {logs.map((l) => (
            <li key={l.id} className={l.status >= 400 ? "text-destructive" : ""}>
              [{new Date(l.created_at).toLocaleTimeString()}] {l.operation} · {l.model} · {l.status} · {l.latency_ms}ms · tok {l.input_tokens ?? 0}/{l.output_tokens ?? 0} · ${Number(l.cost_usd ?? 0).toFixed(5)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
