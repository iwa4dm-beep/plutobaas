import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { plutoApi, getUpstream } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/database-import")({
  component: DbImportPage,
  head: () => ({ meta: [{ title: "Database Import & Connect · Pluto Admin" }] }),
});

type Conn = {
  id: string; name: string; dialect: string; host: string | null;
  port: number | null; database_name: string | null; username: string | null;
  ssl: boolean; last_test_ok: boolean | null; last_test_error: string | null;
};
type Job = {
  id: string; kind: string; source_dialect: string; target_schema: string;
  file_name: string | null; file_bytes: number | null; status: string;
  stmt_total: number; stmt_applied: number; stmt_failed: number;
  rows_inserted: number; error_message: string | null;
  log?: string; created_at: string; finished_at: string | null;
};

const TABS = ["Connections", "Import File", "Export", "History"] as const;

function DbImportPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Connections");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Connections
  const [conns, setConns] = useState<Conn[]>([]);
  const [form, setForm] = useState({
    name: "", dialect: "mysql" as "mysql" | "mariadb" | "postgres" | "sqlite",
    host: "", port: 3306, database_name: "", username: "", password: "", ssl: false,
  });
  const [testing, setTesting] = useState(false);

  async function loadConns() {
    try {
      const r = await plutoApi<{ connections: Conn[] }>("/admin/v1/dbio/connections");
      setConns(r.connections);
    } catch (e: any) { setErr(e.message); }
  }
  async function testConn() {
    setTesting(true); setErr(null); setMsg(null);
    try {
      const r = await plutoApi<{ ok: boolean; error?: string }>(
        "/admin/v1/dbio/connections/test",
        { method: "POST", body: JSON.stringify(form) },
      );
      if (r.ok) setMsg("✓ Connection successful"); else setErr("Test failed: " + (r.error ?? "unknown"));
    } catch (e: any) { setErr(e.message); } finally { setTesting(false); }
  }
  async function saveConn() {
    setErr(null); setMsg(null);
    try {
      await plutoApi("/admin/v1/dbio/connections", { method: "POST", body: JSON.stringify(form) });
      setMsg("Saved");
      setForm({ ...form, name: "", password: "" });
      await loadConns();
    } catch (e: any) { setErr(e.message); }
  }
  async function delConn(id: string) {
    if (!confirm("Delete this connection?")) return;
    try { await plutoApi(`/admin/v1/dbio/connections/${id}`, { method: "DELETE" }); await loadConns(); }
    catch (e: any) { setErr(e.message); }
  }

  // Import
  const [importSchema, setImportSchema] = useState("public");
  const [importKind, setImportKind] = useState<"dump" | "schema" | "csv">("dump");
  const [csvTable, setCsvTable] = useState("");
  const [continueOnError, setContinueOnError] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadFile() {
    const f = fileRef.current?.files?.[0]; if (!f) { setErr("Pick a file first"); return; }
    setUploading(true); setErr(null); setMsg(null); setActiveJob(null);
    try {
      const { url, token } = getUpstream();
      const base = (url || "/api/pluto").replace(/\/+$/, "");
      const qs = new URLSearchParams({ schema: importSchema });
      if (importKind === "dump") qs.set("continueOnError", String(continueOnError));
      if (importKind === "csv") { qs.set("table", csvTable); qs.set("create", "true"); }
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(`${base}/admin/v1/dbio/import/${importKind}?${qs}`, {
        method: "POST", body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? j?.message ?? res.statusText);
      setMsg(`Started job ${j.job_id}`);
      pollJob(j.job_id);
    } catch (e: any) { setErr(e.message); } finally { setUploading(false); }
  }

  function pollJob(id: string) {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const j = await plutoApi<Job>(`/admin/v1/dbio/jobs/${id}`);
        setActiveJob(j);
        if (j.status === "running" || j.status === "pending") setTimeout(tick, 1500);
      } catch (e: any) { setErr(e.message); }
    };
    tick();
    return () => { alive = false; };
  }

  // Export
  const [expSchema, setExpSchema] = useState("public");
  const [expTable, setExpTable] = useState("");
  function downloadExport() {
    const { url, token } = getUpstream();
    const base = (url || "/api/pluto").replace(/\/+$/, "");
    const qs = new URLSearchParams({ schema: expSchema, table: expTable });
    // Token can't ride in <a href> easily → open via fetch + blob
    fetch(`${base}/admin/v1/dbio/export/sql?${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        const blob = await r.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${expSchema}_${expTable}.sql`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => setErr(e.message));
  }

  // History
  const [jobs, setJobs] = useState<Job[]>([]);
  async function loadJobs() {
    try { const r = await plutoApi<{ jobs: Job[] }>("/admin/v1/dbio/jobs"); setJobs(r.jobs); }
    catch (e: any) { setErr(e.message); }
  }

  useEffect(() => {
    if (tab === "Connections") loadConns();
    if (tab === "History") loadJobs();
  }, [tab]);

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Database Import & Connect</h1>
        <p className="text-sm text-muted-foreground">
          Save external MySQL / Postgres connections, upload .sql / .csv dumps, and pipe them into your Pluto database.
          MySQL dumps are auto-converted to Postgres syntax on import.
        </p>
      </div>

      <div className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setErr(null); setMsg(null); }}
            className={"px-4 py-2 text-sm border-b-2 -mb-px " + (tab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground")}
          >{t}</button>
        ))}
      </div>

      {err && <div className="text-sm text-destructive border border-destructive/40 bg-destructive/10 rounded p-2">{err}</div>}
      {msg && <div className="text-sm text-emerald-600 border border-emerald-500/40 bg-emerald-500/10 rounded p-2">{msg}</div>}

      {tab === "Connections" && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="border rounded-lg p-4 space-y-2">
            <h2 className="font-medium text-sm">Add new</h2>
            <input className="border rounded px-3 py-2 text-sm w-full" placeholder="Name (e.g. cpanel-mysql)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <select className="border rounded px-3 py-2 text-sm w-full" value={form.dialect} onChange={(e) => setForm({ ...form, dialect: e.target.value as any, port: e.target.value === "postgres" ? 5432 : 3306 })}>
              <option value="mysql">MySQL</option>
              <option value="mariadb">MariaDB</option>
              <option value="postgres">PostgreSQL</option>
              <option value="sqlite">SQLite (file only)</option>
            </select>
            <div className="grid grid-cols-3 gap-2">
              <input className="col-span-2 border rounded px-3 py-2 text-sm" placeholder="host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              <input type="number" className="border rounded px-3 py-2 text-sm" placeholder="port" value={form.port} onChange={(e) => setForm({ ...form, port: +e.target.value })} />
            </div>
            <input className="border rounded px-3 py-2 text-sm w-full" placeholder="database" value={form.database_name} onChange={(e) => setForm({ ...form, database_name: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <input className="border rounded px-3 py-2 text-sm" placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              <input type="password" className="border rounded px-3 py-2 text-sm" placeholder="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.checked })} /> Use SSL</label>
            <div className="flex gap-2">
              <button disabled={testing} onClick={testConn} className="px-3 py-2 text-sm rounded border">{testing ? "Testing…" : "Test"}</button>
              <button onClick={saveConn} className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground">Save</button>
            </div>
          </div>

          <div className="border rounded-lg p-4 space-y-2">
            <h2 className="font-medium text-sm">Saved ({conns.length})</h2>
            {!conns.length && <div className="text-xs text-muted-foreground">None yet.</div>}
            {conns.map((c) => (
              <div key={c.id} className="border rounded p-2 text-sm flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{c.name} <span className="text-xs text-muted-foreground">· {c.dialect}</span></div>
                  <div className="text-xs text-muted-foreground">{c.username}@{c.host}:{c.port}/{c.database_name}{c.ssl ? " · SSL" : ""}</div>
                  {c.last_test_ok === false && <div className="text-xs text-destructive">✗ {c.last_test_error}</div>}
                </div>
                <button className="text-xs text-destructive underline" onClick={() => delConn(c.id)}>Delete</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "Import File" && (
        <div className="border rounded-lg p-4 space-y-3 max-w-2xl">
          <div className="flex gap-2 text-sm">
            {(["dump", "schema", "csv"] as const).map((k) => (
              <button key={k} onClick={() => setImportKind(k)} className={"px-3 py-1 rounded border " + (importKind === k ? "bg-primary text-primary-foreground" : "")}>{k.toUpperCase()}</button>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">
            {importKind === "dump" && "Full mysqldump / pg_dump (.sql or .sql.gz). MySQL is auto-converted."}
            {importKind === "schema" && "DDL-only .sql file (CREATE TABLE, etc.)."}
            {importKind === "csv" && "CSV file with header row. New table will be created (all text columns)."}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">Target schema
              <input className="border rounded px-2 py-1 text-sm w-full" value={importSchema} onChange={(e) => setImportSchema(e.target.value)} />
            </label>
            {importKind === "csv" && (
              <label className="text-sm">Target table
                <input className="border rounded px-2 py-1 text-sm w-full" value={csvTable} onChange={(e) => setCsvTable(e.target.value)} />
              </label>
            )}
          </div>
          {importKind === "dump" && (
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={continueOnError} onChange={(e) => setContinueOnError(e.target.checked)} /> Continue on error (per-statement, best-effort)</label>
          )}
          <input ref={fileRef} type="file" accept=".sql,.gz,.csv,.txt" className="text-sm" />
          <button disabled={uploading} onClick={uploadFile} className="px-4 py-2 text-sm rounded bg-primary text-primary-foreground">
            {uploading ? "Uploading…" : "Import"}
          </button>

          {activeJob && (
            <div className="border rounded p-3 text-sm space-y-1">
              <div>Job <span className="font-mono text-xs">{activeJob.id}</span> — <b>{activeJob.status}</b></div>
              <div className="text-xs">Statements: {activeJob.stmt_applied}/{activeJob.stmt_total} applied · {activeJob.stmt_failed} failed{activeJob.rows_inserted ? ` · ${activeJob.rows_inserted} rows` : ""}</div>
              {activeJob.stmt_total > 0 && (
                <div className="h-2 bg-muted rounded overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (activeJob.stmt_applied / activeJob.stmt_total) * 100)}%` }} />
                </div>
              )}
              {activeJob.error_message && <div className="text-xs text-destructive">{activeJob.error_message}</div>}
              {activeJob.log && <pre className="text-[10px] bg-muted p-2 max-h-64 overflow-auto whitespace-pre-wrap">{activeJob.log}</pre>}
            </div>
          )}
        </div>
      )}

      {tab === "Export" && (
        <div className="border rounded-lg p-4 space-y-2 max-w-lg">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">Schema<input className="border rounded px-2 py-1 text-sm w-full" value={expSchema} onChange={(e) => setExpSchema(e.target.value)} /></label>
            <label className="text-sm">Table<input className="border rounded px-2 py-1 text-sm w-full" value={expTable} onChange={(e) => setExpTable(e.target.value)} /></label>
          </div>
          <button onClick={downloadExport} disabled={!expTable} className="px-4 py-2 text-sm rounded bg-primary text-primary-foreground">Download .sql</button>
          <div className="text-xs text-muted-foreground">Emits schema-qualified INSERT statements. For full pg_dump-quality backups use Backups.</div>
        </div>
      )}

      {tab === "History" && (
        <div className="border rounded-lg overflow-auto">
          <table className="text-xs w-full">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Kind</th>
                <th className="text-left px-3 py-2">File</th>
                <th className="text-left px-3 py-2">Schema</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Applied / Total</th>
                <th className="text-left px-3 py-2">Rows</th>
                <th className="text-left px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t">
                  <td className="px-3 py-1">{new Date(j.created_at).toLocaleString()}</td>
                  <td className="px-3 py-1">{j.kind}</td>
                  <td className="px-3 py-1">{j.file_name}</td>
                  <td className="px-3 py-1">{j.target_schema}</td>
                  <td className={"px-3 py-1 " + (j.status === "failed" ? "text-destructive" : j.status === "success" ? "text-emerald-600" : "")}>{j.status}</td>
                  <td className="px-3 py-1">{j.stmt_applied}/{j.stmt_total} ({j.stmt_failed} failed)</td>
                  <td className="px-3 py-1">{j.rows_inserted}</td>
                  <td className="px-3 py-1 max-w-64 truncate">{j.error_message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
