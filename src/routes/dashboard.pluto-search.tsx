import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-search")({
  component: SearchPage,
  head: () => ({ meta: [{ title: "Pluto Search & Vector" }] }),
});

function SearchPage() {
  const [projectId, setProjectId] = useState("");
  const [tab, setTab] = useState<"fts" | "vector">("fts");
  const [err, setErr] = useState<string | null>(null);

  // FTS
  const [ftsCfgs, setFtsCfgs] = useState<any[]>([]);
  const [ftsForm, setFtsForm] = useState({ schema: "public", table: "", column: "", language: "english" });
  const [ftsQ, setFtsQ] = useState({ schema: "public", table: "", query: "" });
  const [ftsResults, setFtsResults] = useState<any[]>([]);

  // Vector
  const [vecCfgs, setVecCfgs] = useState<any[]>([]);
  const [vecForm, setVecForm] = useState({ schema: "public", table: "", column: "embedding", dimensions: 1536, metric: "cosine" as const, index_kind: "ivfflat" as const });
  const [vecQ, setVecQ] = useState({ schema: "public", table: "", column: "embedding", vector: "" });
  const [vecResults, setVecResults] = useState<any[]>([]);

  async function refresh() {
    if (!projectId) return;
    try {
      const [f, v] = await Promise.all([
        plutoApi<any[]>(`/admin/v1/search/fts?project_id=${projectId}`),
        plutoApi<any[]>(`/admin/v1/search/vector?project_id=${projectId}`),
      ]);
      setFtsCfgs(f); setVecCfgs(v); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function enableFts() {
    try {
      await plutoApi(`/admin/v1/search/fts/enable`, { method: "POST", body: JSON.stringify({ project_id: projectId, ...ftsForm }) });
      pushUiHistory({ action: "fts.enable", detail: `${ftsForm.table}.${ftsForm.column}`, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function runFts() {
    try { setFtsResults(await plutoApi<any[]>(`/admin/v1/search/fts/query`, { method: "POST", body: JSON.stringify({ project_id: projectId, ...ftsQ }) })); }
    catch (e: any) { setErr(e.message); }
  }
  async function enableVec() {
    try {
      await plutoApi(`/admin/v1/search/vector/enable`, { method: "POST", body: JSON.stringify({ project_id: projectId, ...vecForm }) });
      pushUiHistory({ action: "vector.enable", detail: `${vecForm.table}.${vecForm.column}`, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function runVec() {
    try {
      const vector = vecQ.vector.trim().replace(/^\[|\]$/g, "").split(",").map((n) => parseFloat(n.trim()));
      setVecResults(await plutoApi<any[]>(`/admin/v1/search/vector/query`, {
        method: "POST", body: JSON.stringify({ project_id: projectId, ...vecQ, vector }),
      }));
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Search & Vector</h1>
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{err}</div>}
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-xs">Project ID
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[320px]" placeholder="uuid" />
        </label>
        <div className="flex gap-1 ml-4">
          {(["fts", "vector"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm rounded-md ${tab === t ? "bg-primary text-primary-foreground" : "border"}`}>
              {t === "fts" ? "Full-text" : "Vector"}
            </button>
          ))}
        </div>
      </div>

      {tab === "fts" && (
        <div className="space-y-4">
          <section className="rounded-md border p-4 space-y-2">
            <h2 className="text-sm font-medium">Enable FTS on a column</h2>
            <div className="grid grid-cols-4 gap-2">
              <input placeholder="schema" value={ftsForm.schema} onChange={(e) => setFtsForm({ ...ftsForm, schema: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="table" value={ftsForm.table} onChange={(e) => setFtsForm({ ...ftsForm, table: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="column" value={ftsForm.column} onChange={(e) => setFtsForm({ ...ftsForm, column: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="language" value={ftsForm.language} onChange={(e) => setFtsForm({ ...ftsForm, language: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
            </div>
            <button onClick={enableFts} disabled={!projectId || !ftsForm.table || !ftsForm.column} className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">Enable FTS</button>
          </section>

          <section>
            <h3 className="text-xs uppercase text-muted-foreground mb-1">Enabled columns</h3>
            <div className="rounded-md border overflow-hidden text-sm">
              {ftsCfgs.map((c) => (
                <div key={c.id} className="border-t px-3 py-2 flex justify-between">
                  <span className="font-mono text-xs">{c.schema_name}.{c.table_name}.{c.column_name}</span>
                  <span className="text-muted-foreground text-xs">{c.language} → {c.tsv_column}</span>
                </div>
              ))}
              {ftsCfgs.length === 0 && <div className="p-3 text-muted-foreground text-sm">None</div>}
            </div>
          </section>

          <section className="rounded-md border p-4 space-y-2">
            <h2 className="text-sm font-medium">Query</h2>
            <div className="grid grid-cols-3 gap-2">
              <input placeholder="schema" value={ftsQ.schema} onChange={(e) => setFtsQ({ ...ftsQ, schema: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="table" value={ftsQ.table} onChange={(e) => setFtsQ({ ...ftsQ, table: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="query string" value={ftsQ.query} onChange={(e) => setFtsQ({ ...ftsQ, query: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
            </div>
            <button onClick={runFts} className="rounded-md border text-sm px-3 py-2">Search</button>
            <pre className="bg-muted/40 p-2 text-xs rounded max-h-[300px] overflow-auto">{JSON.stringify(ftsResults, null, 2)}</pre>
          </section>
        </div>
      )}

      {tab === "vector" && (
        <div className="space-y-4">
          <section className="rounded-md border p-4 space-y-2">
            <h2 className="text-sm font-medium">Enable vector column</h2>
            <div className="grid grid-cols-3 gap-2">
              <input placeholder="schema" value={vecForm.schema} onChange={(e) => setVecForm({ ...vecForm, schema: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="table" value={vecForm.table} onChange={(e) => setVecForm({ ...vecForm, table: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="column" value={vecForm.column} onChange={(e) => setVecForm({ ...vecForm, column: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input type="number" placeholder="dimensions" value={vecForm.dimensions} onChange={(e) => setVecForm({ ...vecForm, dimensions: parseInt(e.target.value || "0") })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <select value={vecForm.metric} onChange={(e) => setVecForm({ ...vecForm, metric: e.target.value as any })} className="rounded-md border bg-background px-3 py-1.5 text-sm">
                <option value="cosine">cosine</option><option value="l2">l2</option><option value="ip">ip</option>
              </select>
              <select value={vecForm.index_kind} onChange={(e) => setVecForm({ ...vecForm, index_kind: e.target.value as any })} className="rounded-md border bg-background px-3 py-1.5 text-sm">
                <option value="ivfflat">ivfflat</option><option value="hnsw">hnsw</option><option value="none">none</option>
              </select>
            </div>
            <button onClick={enableVec} disabled={!projectId || !vecForm.table} className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">Enable vector</button>
          </section>

          <section>
            <h3 className="text-xs uppercase text-muted-foreground mb-1">Enabled vector columns</h3>
            <div className="rounded-md border overflow-hidden text-sm">
              {vecCfgs.map((c) => (
                <div key={c.id} className="border-t px-3 py-2 flex justify-between">
                  <span className="font-mono text-xs">{c.schema_name}.{c.table_name}.{c.column_name}</span>
                  <span className="text-muted-foreground text-xs">dim={c.dimensions} {c.metric} {c.index_kind}</span>
                </div>
              ))}
              {vecCfgs.length === 0 && <div className="p-3 text-muted-foreground text-sm">None</div>}
            </div>
          </section>

          <section className="rounded-md border p-4 space-y-2">
            <h2 className="text-sm font-medium">Similarity query</h2>
            <div className="grid grid-cols-3 gap-2">
              <input placeholder="schema" value={vecQ.schema} onChange={(e) => setVecQ({ ...vecQ, schema: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="table" value={vecQ.table} onChange={(e) => setVecQ({ ...vecQ, table: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="column" value={vecQ.column} onChange={(e) => setVecQ({ ...vecQ, column: e.target.value })} className="rounded-md border bg-background px-3 py-1.5 text-sm" />
            </div>
            <textarea placeholder="[0.01, 0.42, ...]" value={vecQ.vector} onChange={(e) => setVecQ({ ...vecQ, vector: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-xs font-mono h-24" />
            <button onClick={runVec} className="rounded-md border text-sm px-3 py-2">Search</button>
            <pre className="bg-muted/40 p-2 text-xs rounded max-h-[300px] overflow-auto">{JSON.stringify(vecResults, null, 2)}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
