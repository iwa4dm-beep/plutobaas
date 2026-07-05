import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-studio")({
  component: StudioPage,
  head: () => ({ meta: [{ title: "Pluto Data Studio" }] }),
});

function StudioPage() {
  const [projectId, setProjectId] = useState("");
  const [schema, setSchema] = useState("public");
  const [tab, setTab] = useState<"tables" | "erd" | "snippets" | "queries">("tables");
  const [tables, setTables] = useState<any[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [cols, setCols] = useState<any>({ columns: [], primary_key: [], foreign_keys: [] });
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [edit, setEdit] = useState<any>(null);
  const [newRow, setNewRow] = useState<Record<string, string>>({});
  const [erd, setErd] = useState<any>(null);
  const [snippets, setSnippets] = useState<any[]>([]);
  const [newSnippet, setNewSnippet] = useState({ name: "", sql: "", description: "" });
  const [queries, setQueries] = useState<any[]>([]);
  const [newQuery, setNewQuery] = useState({ name: "", sql: "" });
  const [queryResult, setQueryResult] = useState<any>(null);
  const [csvText, setCsvText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function loadTables() {
    try { setTables(await plutoApi(`/admin/v1/studio/tables?schema=${schema}`)); } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void loadTables(); }, [schema]);

  async function openTable(name: string) {
    setSelected(name); setEdit(null);
    try {
      setCols(await plutoApi(`/admin/v1/studio/columns?schema=${schema}&table=${name}`));
      const r = await plutoApi<any>(`/admin/v1/studio/rows?schema=${schema}&table=${name}&limit=50`);
      setRows(r.rows); setTotal(r.total);
    } catch (e: any) { setErr(e.message); }
  }

  async function insertRow() {
    try {
      await plutoApi("/admin/v1/studio/rows", { method: "POST", body: JSON.stringify({ schema, table: selected, values: newRow }) });
      setNewRow({}); await openTable(selected);
    } catch (e: any) { setErr(e.message); }
  }
  async function saveEdit() {
    if (!edit) return;
    const pkCol = cols.primary_key[0]; if (!pkCol) { setErr("no primary key"); return; }
    try {
      const values: any = {}; Object.keys(edit).forEach((k) => { if (k !== pkCol) values[k] = edit[k]; });
      await plutoApi("/admin/v1/studio/rows", { method: "PATCH", body: JSON.stringify({ schema, table: selected, pk_column: pkCol, pk_value: edit[pkCol], values }) });
      setEdit(null); await openTable(selected);
    } catch (e: any) { setErr(e.message); }
  }
  async function delRow(r: any) {
    const pkCol = cols.primary_key[0]; if (!pkCol) return;
    if (!confirm("Delete this row?")) return;
    try { await plutoApi("/admin/v1/studio/rows", { method: "DELETE", body: JSON.stringify({ schema, table: selected, pk_column: pkCol, pk_value: r[pkCol] }) }); await openTable(selected); } catch (e: any) { setErr(e.message); }
  }
  function exportCsv() { window.open(`/admin/v1/studio/export.csv?schema=${schema}&table=${selected}`, "_blank"); }
  async function importCsv() {
    try { const r = await plutoApi<any>("/admin/v1/studio/import.csv", { method: "POST", body: JSON.stringify({ schema, table: selected, csv: csvText }) }); alert(`Inserted ${r.inserted}`); setCsvText(""); await openTable(selected); } catch (e: any) { setErr(e.message); }
  }
  async function loadErd() { try { setErd(await plutoApi(`/admin/v1/studio/erd?schema=${schema}`)); } catch (e: any) { setErr(e.message); } }
  async function loadSnippets() { if (!projectId) return; try { setSnippets(await plutoApi(`/admin/v1/studio/snippets?project_id=${projectId}`)); } catch (e: any) { setErr(e.message); } }
  async function loadQueries() { if (!projectId) return; try { setQueries(await plutoApi(`/admin/v1/studio/queries?project_id=${projectId}`)); } catch (e: any) { setErr(e.message); } }
  async function saveSnippet() { try { await plutoApi("/admin/v1/studio/snippets", { method: "POST", body: JSON.stringify({ project_id: projectId, ...newSnippet, tags: [] }) }); setNewSnippet({ name: "", sql: "", description: "" }); await loadSnippets(); } catch (e: any) { setErr(e.message); } }
  async function saveQuery() { try { await plutoApi("/admin/v1/studio/queries", { method: "POST", body: JSON.stringify({ project_id: projectId, ...newQuery, params: {} }) }); setNewQuery({ name: "", sql: "" }); await loadQueries(); } catch (e: any) { setErr(e.message); } }
  async function runQuery(id: string) { try { setQueryResult(await plutoApi(`/admin/v1/studio/queries/${id}/run`, { method: "POST" })); } catch (e: any) { setErr(e.message); } }

  useEffect(() => { if (tab === "erd") void loadErd(); if (tab === "snippets") void loadSnippets(); if (tab === "queries") void loadQueries(); }, [tab, projectId]);

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Data Studio</h1>
        <p className="text-sm text-muted-foreground">Spreadsheet-style editor, FK navigation, SQL snippets, saved queries, CSV, ERD.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="border rounded px-3 py-2 text-sm w-72" placeholder="project_id (for snippets/queries)" value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        <input className="border rounded px-3 py-2 text-sm" placeholder="schema" value={schema} onChange={(e) => setSchema(e.target.value)} />
        <div className="flex border rounded overflow-hidden">
          {(["tables", "erd", "snippets", "queries"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={"px-3 py-2 text-sm " + (tab === t ? "bg-primary text-primary-foreground" : "")}>{t}</button>
          ))}
        </div>
      </div>
      {err && <div className="text-sm text-destructive">{err}</div>}

      {tab === "tables" && (
        <div className="grid grid-cols-4 gap-4">
          <div className="border rounded-lg p-3 space-y-1 max-h-[70vh] overflow-auto">
            <div className="text-xs text-muted-foreground mb-2">Tables ({tables.length})</div>
            {tables.map((t) => (
              <button key={t.name} onClick={() => openTable(t.name)} className={"block w-full text-left px-2 py-1 text-sm rounded " + (selected === t.name ? "bg-accent" : "hover:bg-accent/50")}>
                {t.name} <span className="text-xs text-muted-foreground">({t.columns})</span>
              </button>
            ))}
          </div>
          <div className="col-span-3 space-y-3">
            {selected && (
              <>
                <div className="flex gap-2 text-sm">
                  <b>{schema}.{selected}</b> · {total} rows · PK: {cols.primary_key.join(",") || "—"}
                  <button className="ml-auto underline" onClick={exportCsv}>Export CSV</button>
                </div>
                {cols.foreign_keys.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    FKs: {cols.foreign_keys.map((f: any) => (
                      <button key={f.column_name} className="underline mr-2" onClick={() => openTable(f.ref_table)}>
                        {f.column_name}→{f.ref_table}.{f.ref_column}
                      </button>
                    ))}
                  </div>
                )}
                <div className="overflow-auto border rounded max-h-[50vh]">
                  <table className="text-xs w-full">
                    <thead className="bg-muted sticky top-0"><tr>{cols.columns.map((c: any) => <th key={c.name} className="text-left px-2 py-1">{c.name}<div className="text-[10px] text-muted-foreground">{c.data_type}</div></th>)}<th></th></tr></thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-t hover:bg-accent/30">
                          {cols.columns.map((c: any) => (
                            <td key={c.name} className="px-2 py-1 max-w-48 truncate">
                              {edit && edit === r ? <input className="border px-1 w-full" value={edit[c.name] ?? ""} onChange={(e) => setEdit({ ...edit, [c.name]: e.target.value })} /> : String(r[c.name] ?? "")}
                            </td>
                          ))}
                          <td className="whitespace-nowrap px-2">
                            {edit === r ? (
                              <><button className="underline mr-2" onClick={saveEdit}>Save</button><button className="underline" onClick={() => setEdit(null)}>Cancel</button></>
                            ) : (
                              <><button className="underline mr-2" onClick={() => setEdit({ ...r })}>Edit</button><button className="underline text-destructive" onClick={() => delRow(r)}>Del</button></>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details className="border rounded p-3">
                  <summary className="text-sm cursor-pointer">Insert new row</summary>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {cols.columns.map((c: any) => (
                      <div key={c.name}>
                        <label className="block text-xs text-muted-foreground">{c.name}</label>
                        <input className="border rounded px-2 py-1 text-sm w-full" value={newRow[c.name] ?? ""} onChange={(e) => setNewRow({ ...newRow, [c.name]: e.target.value })} />
                      </div>
                    ))}
                  </div>
                  <button className="mt-2 px-3 py-1 text-sm rounded bg-primary text-primary-foreground" onClick={insertRow}>Insert</button>
                </details>
                <details className="border rounded p-3">
                  <summary className="text-sm cursor-pointer">Import CSV</summary>
                  <textarea className="border rounded p-2 text-xs font-mono w-full mt-2 h-32" placeholder="col1,col2&#10;val,val" value={csvText} onChange={(e) => setCsvText(e.target.value)} />
                  <button className="mt-2 px-3 py-1 text-sm rounded bg-primary text-primary-foreground" onClick={importCsv}>Import</button>
                </details>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "erd" && erd && (
        <div className="border rounded-lg p-4">
          <div className="text-sm mb-2">Schema: {erd.schema} · {erd.tables.length} tables · {erd.edges.length} relations</div>
          <div className="grid grid-cols-3 gap-3">
            {erd.tables.map((t: any) => {
              const outgoing = erd.edges.filter((e: any) => e.source === t.name);
              return (
                <div key={t.name} className="border rounded p-2 text-xs">
                  <div className="font-medium">{t.name}</div>
                  {outgoing.map((e: any, i: number) => <div key={i} className="text-muted-foreground">→ {e.target} ({e.column_name})</div>)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "snippets" && (
        <div className="space-y-3">
          <div className="border rounded p-3 space-y-2">
            <input className="border rounded px-3 py-2 text-sm w-full" placeholder="name" value={newSnippet.name} onChange={(e) => setNewSnippet({ ...newSnippet, name: e.target.value })} />
            <textarea className="border rounded px-3 py-2 text-sm w-full font-mono h-32" placeholder="SQL..." value={newSnippet.sql} onChange={(e) => setNewSnippet({ ...newSnippet, sql: e.target.value })} />
            <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={saveSnippet}>Save snippet</button>
          </div>
          <div className="space-y-2">
            {snippets.map((s) => (
              <div key={s.id} className="border rounded p-3">
                <div className="font-medium text-sm">{s.name}</div>
                <pre className="text-xs bg-muted p-2 mt-1 overflow-x-auto">{s.sql}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "queries" && (
        <div className="space-y-3">
          <div className="border rounded p-3 space-y-2">
            <input className="border rounded px-3 py-2 text-sm w-full" placeholder="name" value={newQuery.name} onChange={(e) => setNewQuery({ ...newQuery, name: e.target.value })} />
            <textarea className="border rounded px-3 py-2 text-sm w-full font-mono h-32" placeholder="SELECT ..." value={newQuery.sql} onChange={(e) => setNewQuery({ ...newQuery, sql: e.target.value })} />
            <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={saveQuery}>Save query</button>
          </div>
          <div className="space-y-2">
            {queries.map((q) => (
              <div key={q.id} className="border rounded p-3">
                <div className="flex justify-between"><div className="font-medium text-sm">{q.name}</div><button className="underline text-sm" onClick={() => runQuery(q.id)}>Run</button></div>
                <pre className="text-xs bg-muted p-2 mt-1 overflow-x-auto">{q.sql}</pre>
              </div>
            ))}
          </div>
          {queryResult && (
            <div className="border rounded p-3">
              <div className="text-sm mb-2">Result ({queryResult.count} rows)</div>
              <pre className="text-xs bg-muted p-2 overflow-auto max-h-64">{JSON.stringify(queryResult.rows, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
