import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, Play, RefreshCw, GitBranch, Wand2, Camera, Undo2, Lock } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { isLive, branching, studio, me, type DbBranch, type BranchChange, type BranchSnapshot, type SchemaOp, type WorkspaceRole } from "@/lib/pluto/live";

// Phase 22b — Workspace-role RBAC gates schema apply / branch apply. Non-admins can still browse.
function useWorkspaceAdmin(): { role: WorkspaceRole; canAdmin: boolean } {
  const [role, setRole] = useState<WorkspaceRole>("member");
  useEffect(() => {
    if (!isLive()) return;
    me.workspaceRole().then((r) => setRole(r.role)).catch(() => setRole("anon"));
  }, []);
  return {
    role,
    canAdmin: role === "owner" || role === "admin" || role === "global_admin" || role === "service_role",
  };
}

export const Route = createFileRoute("/dashboard/branching")({ component: BranchingPage });

// Phase 21 — Branching + Studio schema editor MVP.
// The Studio compiles structured operations into deterministic SQL (dry-run
// available). Applied ops are recorded in `public.schema_edits` so the audit
// trail always shows exactly what ran.

function BranchingPage() {
  const [tab, setTab] = useState<"branches" | "studio">("branches");
  const { role, canAdmin } = useWorkspaceAdmin();
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Branching & Studio"
        description="Isolate schema changes per branch and build tables/columns/indexes/relations with a guided editor."
      />
      <AutoHelpPanel slug={'dashboard.branching'} title={'Branching & Studio'} description={'Isolate schema changes per branch and build tables/columns/indexes/relations with a guided editor.'} />
      {!isLive() && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
          Set <code>VITE_PLUTO_URL</code> to a running Pluto instance to use branching &amp; studio.
        </div>
      )}
      {!canAdmin && isLive() && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs inline-flex items-center gap-2">
          <Lock className="h-3 w-3" /> Read-only view — schema apply is restricted to workspace admins (your role: <code>{role}</code>).
        </div>
      )}
      <div className="flex gap-2 border-b border-border">
        {(["branches", "studio"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize -mb-px border-b-2 ${tab === t
              ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t === "branches" ? "Database branches" : "Schema studio"}
          </button>
        ))}
      </div>
      {tab === "branches" ? <BranchesTab canAdmin={canAdmin} /> : <StudioTab canAdmin={canAdmin} />}
    </div>
  );
}

function BranchesTab({ canAdmin }: { canAdmin: boolean }) {
  const [rows, setRows] = useState<DbBranch[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [copyFrom, setCopyFrom] = useState("public");
  const [selected, setSelected] = useState<string | null>(null);
  const [changes, setChanges] = useState<BranchChange[]>([]);
  const [snapshots, setSnapshots] = useState<BranchSnapshot[]>([]);
  const [snapReason, setSnapReason] = useState("");
  const [sql, setSql] = useState("");
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { const r = await branching.list(); setRows(r.branches); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadChanges = useCallback(async (id: string) => {
    try {
      const [c, s] = await Promise.all([branching.changes(id), branching.snapshots(id)]);
      setChanges(c.changes); setSnapshots(s.snapshots);
    } catch (e) { setErr((e as Error).message); }
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await branching.create({ name: name.trim(), copy_from: copyFrom || undefined });
      setName(""); await load();
    } catch (e) { setErr((e as Error).message); }
  };
  const remove = async (id: string) => {
    if (!confirm("Drop this branch and its schema? This cannot be undone.")) return;
    try { await branching.remove(id); if (selected === id) setSelected(null); await load(); }
    catch (e) { setErr((e as Error).message); }
  };
  const apply = async () => {
    if (!selected || !sql.trim()) return;
    setApplying(true);
    try { await branching.apply(selected, sql); setSql(""); await loadChanges(selected); }
    catch (e) { setErr((e as Error).message); }
    finally { setApplying(false); }
  };
  const takeSnapshot = async () => {
    if (!selected) return;
    try { await branching.createSnapshot(selected, snapReason || undefined); setSnapReason(""); await loadChanges(selected); }
    catch (e) { setErr((e as Error).message); }
  };
  const restore = async (snapId: string) => {
    if (!selected) return;
    if (!confirm("Restore this snapshot? The current branch schema will be swapped out.")) return;
    try { await branching.restoreSnapshot(selected, snapId); await loadChanges(selected); }
    catch (e) { setErr((e as Error).message); }
  };
  const dropSnap = async (snapId: string) => {
    if (!selected) return;
    if (!confirm("Delete this snapshot permanently?")) return;
    try { await branching.deleteSnapshot(selected, snapId); await loadChanges(selected); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <div className="rounded-lg border border-border bg-card">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="text-sm font-medium">Branches</div>
          <button onClick={() => void load()} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
        <div className="p-3 space-y-2 border-b border-border">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="branch-name"
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs" />
          <input value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} placeholder="copy tables from schema (optional, e.g. public)"
            className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs" />
          <button onClick={() => void create()} className="w-full inline-flex items-center justify-center gap-1 rounded bg-primary text-primary-foreground text-xs py-1.5">
            <Plus className="h-3 w-3" /> Create branch
          </button>
        </div>
        <div className="max-h-[420px] overflow-auto">
          {loading && <div className="p-3 text-xs text-muted-foreground inline-flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</div>}
          {rows.map((b) => (
            <button key={b.id} onClick={() => { setSelected(b.id); void loadChanges(b.id); }}
              className={`w-full text-left px-3 py-2 border-b border-border flex items-center justify-between ${selected === b.id ? "bg-muted/40" : "hover:bg-muted/20"}`}>
              <div>
                <div className="text-xs font-medium flex items-center gap-1"><GitBranch className="h-3 w-3" /> {b.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{b.schema_name}</div>
              </div>
              <span onClick={(e) => { e.stopPropagation(); void remove(b.id); }}
                className="text-muted-foreground hover:text-red-500"><Trash2 className="h-3 w-3" /></span>
            </button>
          ))}
          {!loading && !rows.length && <div className="p-3 text-xs text-muted-foreground">No branches yet.</div>}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card">
        <div className="p-3 border-b border-border text-sm font-medium">
          {selected ? "Apply SQL to branch" : "Pick a branch to apply changes"}
        </div>
        <div className="p-3 space-y-3">
          <textarea value={sql} onChange={(e) => setSql(e.target.value)}
            disabled={!selected} rows={6} placeholder="alter table users add column tier text default 'free';"
            className="w-full bg-background border border-border rounded px-2 py-2 text-xs font-mono" />
          <button onClick={() => void apply()} disabled={!selected || applying || !sql.trim() || !canAdmin}
            title={canAdmin ? "Apply SQL to branch" : "Workspace admin required"}
            className="inline-flex items-center gap-1 rounded bg-primary text-primary-foreground text-xs px-3 py-1.5 disabled:opacity-40">
            {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : canAdmin ? <Play className="h-3 w-3" /> : <Lock className="h-3 w-3" />} Apply
          </button>
          <div>
            <div className="text-xs font-medium mb-2">Change history</div>
            <div className="max-h-[280px] overflow-auto border border-border rounded">
              {changes.map((c) => (
                <div key={c.id} className="border-b border-border p-2 text-[11px]">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${c.ok ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>{c.ok ? "ok" : "fail"}</span>
                    <span className="text-muted-foreground">{new Date(c.applied_at).toLocaleString()}</span>
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-[10px]">{c.statement}</pre>
                  {c.error && <div className="text-red-500 mt-1">{c.error}</div>}
                </div>
              ))}
              {!changes.length && <div className="p-3 text-xs text-muted-foreground">No changes recorded.</div>}
            </div>
          </div>

          <div className="pt-2">
            <div className="text-xs font-medium mb-2 flex items-center gap-2">
              <Camera className="h-3 w-3" /> Snapshots (PITR-lite)
            </div>
            <div className="flex gap-1 mb-2">
              <input value={snapReason} onChange={(e) => setSnapReason(e.target.value)}
                disabled={!selected} placeholder="reason (optional)"
                className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs" />
              <button onClick={() => void takeSnapshot()} disabled={!selected}
                className="text-xs inline-flex items-center gap-1 border border-border rounded px-2 py-1 disabled:opacity-40">
                <Camera className="h-3 w-3" /> Snapshot
              </button>
            </div>
            <div className="max-h-[200px] overflow-auto border border-border rounded">
              {snapshots.map((s) => (
                <div key={s.id} className="border-b border-border p-2 text-[11px] flex items-center gap-2">
                  <div className="flex-1">
                    <div className="font-mono text-[10px]">{s.snapshot_schema}</div>
                    <div className="text-muted-foreground">{new Date(s.created_at).toLocaleString()} · {s.status}</div>
                    {s.reason && <div className="text-muted-foreground italic">{s.reason}</div>}
                  </div>
                  <button onClick={() => void restore(s.id)} title="Restore"
                    className="text-primary hover:text-primary/80"><Undo2 className="h-3 w-3" /></button>
                  <button onClick={() => void dropSnap(s.id)} title="Delete"
                    className="text-muted-foreground hover:text-red-500"><Trash2 className="h-3 w-3" /></button>
                </div>
              ))}
              {!snapshots.length && <div className="p-3 text-xs text-muted-foreground">No snapshots yet.</div>}
            </div>
          </div>
        </div>
      </div>
      {err && <div className="lg:col-span-2 text-xs text-red-500">{err}</div>}
    </div>
  );
}

// ---------- Studio ----------
type Row = { name: string; type: string; nullable: boolean; primary: boolean };
function StudioTab({ canAdmin }: { canAdmin: boolean }) {
  const [mode, setMode] = useState<"create_table" | "add_column" | "add_index" | "add_fk" | "drop_column">("create_table");
  const [schema, setSchema] = useState("public");
  const [table, setTable] = useState("");
  const [rows, setRows] = useState<Row[]>([{ name: "id", type: "uuid", nullable: false, primary: true }]);
  const [col, setCol] = useState({ name: "", type: "text", nullable: true, def: "" });
  const [idx, setIdx] = useState({ name: "", columns: "", unique: false });
  const [fk, setFk]   = useState({ name: "", column: "", ref_table: "", ref_column: "id" });
  const [preview, setPreview] = useState<string[]>([]);
  const [result, setResult] = useState<Array<{ sql: string; ok: boolean; error?: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [branches, setBranches] = useState<DbBranch[]>([]);
  const [branchId, setBranchId] = useState<string>("");
  const [snapFirst, setSnapFirst] = useState(true);

  useEffect(() => {
    void (async () => {
      try { const r = await branching.list(); setBranches(r.branches); } catch { /* offline */ }
    })();
  }, []);

  const op: SchemaOp | null = useMemo(() => {
    if (mode === "create_table" && table)
      return { op: "create_table", schema, table, columns: rows.map((r) => ({ name: r.name, type: r.type, nullable: r.nullable, primary: r.primary })) };
    if (mode === "add_column" && table && col.name)
      return { op: "add_column", schema, table, column: col.name, type: col.type, nullable: col.nullable, default: col.def || undefined };
    if (mode === "drop_column" && table && col.name)
      return { op: "drop_column", schema, table, column: col.name };
    if (mode === "add_index" && table && idx.name && idx.columns)
      return { op: "add_index", schema, table, name: idx.name, columns: idx.columns.split(",").map((s) => s.trim()).filter(Boolean), unique: idx.unique };
    if (mode === "add_fk" && table && fk.name && fk.column && fk.ref_table)
      return { op: "add_fk", schema, table, name: fk.name, column: fk.column, ref_table: fk.ref_table, ref_column: fk.ref_column };
    return null;
  }, [mode, schema, table, rows, col, idx, fk]);

  const dryRun = async () => {
    if (!op) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await studio.apply([op], { dry_run: true, branch_id: branchId || undefined });
      setPreview((r.statements ?? []).map((s) => s.sql));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!op) return;
    setBusy(true); setErr(null);
    try {
      if (branchId && snapFirst) {
        try { await branching.createSnapshot(branchId, `pre-studio ${op.op} ${(op as { table?: string }).table ?? ""}`); }
        catch (e) { setErr(`snapshot failed: ${(e as Error).message}`); setBusy(false); return; }
      }
      const r = await studio.apply([op], { branch_id: branchId || undefined });
      setResult(r.results ?? []);
      setPreview((r.results ?? []).map((s) => s.sql));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {(["create_table","add_column","drop_column","add_index","add_fk"] as const).map((m) => (
            <button key={m} onClick={() => { setMode(m); setPreview([]); setResult(null); }}
              className={`text-xs px-2 py-1 rounded border ${mode === m ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}>
              {m.replace("_", " ")}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="schema" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
          <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="table" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
        </div>

        {mode === "create_table" && (
          <div className="space-y-2">
            <div className="text-xs font-medium">Columns</div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-1 items-center">
                <input value={r.name} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                  placeholder="name" className="bg-background border border-border rounded px-2 py-1 text-xs" />
                <input value={r.type} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}
                  placeholder="type" className="bg-background border border-border rounded px-2 py-1 text-xs" />
                <label className="text-[10px] flex items-center gap-1"><input type="checkbox" checked={r.nullable} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, nullable: e.target.checked } : x))} /> null</label>
                <label className="text-[10px] flex items-center gap-1"><input type="checkbox" checked={r.primary} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, primary: e.target.checked } : x))} /> pk</label>
                <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-red-500 text-xs">×</button>
              </div>
            ))}
            <button onClick={() => setRows((rs) => [...rs, { name: "", type: "text", nullable: true, primary: false }])}
              className="text-xs text-primary inline-flex items-center gap-1"><Plus className="h-3 w-3" /> Add column</button>
          </div>
        )}
        {(mode === "add_column" || mode === "drop_column") && (
          <div className="grid grid-cols-2 gap-2">
            <input value={col.name} onChange={(e) => setCol({ ...col, name: e.target.value })} placeholder="column name" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
            {mode === "add_column" && <>
              <input value={col.type} onChange={(e) => setCol({ ...col, type: e.target.value })} placeholder="type (text, int, timestamptz)" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
              <input value={col.def} onChange={(e) => setCol({ ...col, def: e.target.value })} placeholder="default (optional)" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
              <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={col.nullable} onChange={(e) => setCol({ ...col, nullable: e.target.checked })} /> nullable</label>
            </>}
          </div>
        )}
        {mode === "add_index" && (
          <div className="grid grid-cols-2 gap-2">
            <input value={idx.name} onChange={(e) => setIdx({ ...idx, name: e.target.value })} placeholder="index name" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
            <input value={idx.columns} onChange={(e) => setIdx({ ...idx, columns: e.target.value })} placeholder="col1, col2" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
            <label className="text-xs flex items-center gap-1 col-span-2"><input type="checkbox" checked={idx.unique} onChange={(e) => setIdx({ ...idx, unique: e.target.checked })} /> unique</label>
          </div>
        )}
        {mode === "add_fk" && (
          <div className="grid grid-cols-2 gap-2">
            <input value={fk.name} onChange={(e) => setFk({ ...fk, name: e.target.value })} placeholder="fk name" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
            <input value={fk.column} onChange={(e) => setFk({ ...fk, column: e.target.value })} placeholder="column" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
            <input value={fk.ref_table} onChange={(e) => setFk({ ...fk, ref_table: e.target.value })} placeholder="ref table" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
            <input value={fk.ref_column} onChange={(e) => setFk({ ...fk, ref_column: e.target.value })} placeholder="ref column" className="bg-background border border-border rounded px-2 py-1.5 text-xs" />
          </div>
        )}


        <div className="pt-2 space-y-1 border-t border-border">
          <div className="text-[11px] text-muted-foreground">Target</div>
          <div className="flex flex-wrap gap-2 items-center">
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}
              className="text-xs bg-background border border-border rounded px-2 py-1">
              <option value="">Live (public schema)</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.schema_name}</option>)}
            </select>
            <label className="text-[11px] inline-flex items-center gap-1 text-muted-foreground">
              <input type="checkbox" checked={snapFirst} disabled={!branchId}
                onChange={(e) => setSnapFirst(e.target.checked)} />
              Snapshot branch before apply
            </label>
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button onClick={() => void dryRun()} disabled={!op || busy} className="text-xs inline-flex items-center gap-1 border border-border rounded px-3 py-1.5 disabled:opacity-40">
            <Wand2 className="h-3 w-3" /> Preview SQL
          </button>
          <button onClick={() => void apply()} disabled={!op || busy || !canAdmin}
            title={canAdmin ? "Apply schema change" : "Workspace admin required"}
            className="text-xs inline-flex items-center gap-1 bg-primary text-primary-foreground rounded px-3 py-1.5 disabled:opacity-40">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : canAdmin ? <Play className="h-3 w-3" /> : <Lock className="h-3 w-3" />} {branchId ? "Apply to branch" : "Apply"}
          </button>
        </div>
        {err && <div className="text-xs text-red-500">{err}</div>}
      </div>
      <div className="rounded-lg border border-border bg-card p-4 space-y-2">
        <div className="text-xs font-medium">Generated SQL</div>
        <pre className="text-[11px] font-mono bg-background border border-border rounded p-2 min-h-[120px] whitespace-pre-wrap">{preview.join(";\n") || "-- preview appears here"}</pre>
        {result && (
          <div className="text-xs space-y-1">
            {result.map((r, i) => (
              <div key={i} className={r.ok ? "text-emerald-500" : "text-red-500"}>
                {r.ok ? "✔ applied" : `✖ ${r.error}`}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
