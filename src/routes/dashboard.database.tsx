import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Trash2, Plus, Download, Upload, RefreshCw, Pencil, Table2,
  Columns, FileJson, FileSpreadsheet, Loader2, X, Database, History,
  KeyRound, Rows3, Settings2, ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto, type PlutoTable } from "@/lib/pluto/client";
import { rowsToCsv, downloadCsv, parseCsv } from "@/lib/pluto/csv";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/dashboard/database")({
  component: DatabasePage,
});

const COLUMN_TYPES = ["text", "varchar", "integer", "bigint", "boolean", "uuid", "jsonb", "timestamptz", "date", "numeric", "float8"];
const PAGE_SIZE = 50;
const SQL_HISTORY_KEY = "pluto.sql.history.v1";

type Row = Record<string, unknown>;
type TabKey = "rows" | "schema" | "sql" | "io";

function DatabasePage() {
  const [tables, setTables] = useState<PlutoTable[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<TabKey>("rows");

  // dialogs
  const [rowDialog, setRowDialog] = useState<{ mode: "create" | "edit"; row: Row } | null>(null);
  const [createTable, setCreateTable] = useState(false);
  const [addColumn, setAddColumn] = useState(false);

  const activeTable = tables.find((t) => t.name === active);

  const refreshTables = useCallback(async () => {
    try {
      const t = await pluto.db.listTables();
      setTables(t);
      setLoadErr(null);
      setActive((cur) => cur ?? t[0]?.name ?? null);
    } catch (e) {
      setLoadErr(String(e instanceof Error ? e.message : e));
    }
  }, []);

  const refreshRows = useCallback(async (t: string) => {
    setLoading(true);
    try {
      const r = await pluto.db.listRows(t);
      setRows(r);
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshTables(); }, [refreshTables]);
  useEffect(() => { if (active) { setPage(0); void refreshRows(active); } }, [active, refreshRows]);

  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows;
    const q = filter.toLowerCase();
    return rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q)));
  }, [rows, filter]);
  const pagedRows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));

  async function onDelete(id: string) {
    if (!active) return;
    if (!confirm("Delete this row?")) return;
    try {
      await pluto.db.deleteRow(active, id);
      await refreshRows(active);
      toast.success("Row deleted");
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  }

  async function onExport(format: "csv" | "json") {
    if (!active) return;
    const data = filteredRows;
    if (format === "csv") {
      downloadCsv(`${active}.csv`, rowsToCsv(data));
    } else {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${active}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    toast.success(`Exported ${data.length} rows`);
  }

  async function onDropTable() {
    if (!active) return;
    if (!confirm(`Drop table "${active}"? This cannot be undone.`)) return;
    try {
      await pluto.db.dropTable(active);
      toast.success("Table dropped");
      setActive(null);
      await refreshTables();
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  }

  async function onDropColumn(col: string) {
    if (!active) return;
    if (!confirm(`Drop column "${col}"?`)) return;
    try {
      await pluto.db.dropColumn(active, col);
      await refreshTables();
      await refreshRows(active);
      toast.success("Column dropped");
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  }

  return (
    <div>
      <PageHeader
        title="Database"
        description="Tables, rows, schema, SQL editor, import/export।"
      />

      <div className="grid lg:grid-cols-[240px_minmax(0,1fr)] gap-6">
        {/* ── Sidebar ────────────────────────────────────────────── */}
        <aside className="rounded-lg border border-border bg-card p-3 h-fit">
          <div className="flex items-center justify-between px-1 pb-2">
            <div className="text-xs font-medium text-muted-foreground">public schema</div>
            <button
              onClick={() => void refreshTables()}
              className="p-1 rounded hover:bg-accent text-muted-foreground"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {loadErr && (
            <div className="mb-2 rounded border border-destructive/30 bg-destructive/10 text-destructive px-2 py-1.5 text-[11px] font-mono break-words">
              {loadErr}
            </div>
          )}

          <ul className="space-y-0.5 max-h-[60vh] overflow-y-auto">
            {tables.map((t) => (
              <li key={t.name}>
                <button
                  onClick={() => setActive(t.name)}
                  className={
                    "w-full flex items-center justify-between text-left px-2 py-1.5 rounded text-sm transition-colors " +
                    (active === t.name ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")
                  }
                >
                  <span className="flex min-w-0 items-center gap-2 truncate">
                    <Table2 className="h-3.5 w-3.5 opacity-60 shrink-0" />
                    <span className="truncate">{t.name}</span>
                  </span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{t.row_count}</span>
                </button>
              </li>
            ))}
            {!tables.length && !loadErr && (
              <li className="px-2 py-4 text-xs text-muted-foreground text-center">No tables yet.</li>
            )}
          </ul>

          <Button
            size="sm" variant="outline" className="w-full mt-3"
            onClick={() => setCreateTable(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> New table
          </Button>

          <Link
            to="/dashboard/pluto-schema"
            className="mt-2 flex items-center justify-center gap-1 text-[11px] text-muted-foreground hover:text-foreground rounded px-2 py-1.5 border border-border"
          >
            <Settings2 className="h-3 w-3" /> Indexes & constraints
            <ExternalLink className="h-3 w-3 opacity-60" />
          </Link>
        </aside>

        {/* ── Main pane ──────────────────────────────────────────── */}
        <section className="rounded-lg border border-border bg-card overflow-hidden min-w-0">
          <div className="border-b border-border px-4 py-3 flex items-center justify-between flex-wrap gap-2">
            <div className="min-w-0">
              <div className="font-medium text-sm flex items-center gap-2 truncate">
                <Database className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate">{active ?? "No table selected"}</span>
                {activeTable && (
                  <Badge variant="secondary" className="text-[10px]">
                    {activeTable.row_count} rows · {activeTable.columns.length} cols
                  </Badge>
                )}
              </div>
            </div>
            {active && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Settings2 className="h-3.5 w-3.5 mr-1" /> Table actions
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void refreshRows(active)}>
                    <RefreshCw className="h-3.5 w-3.5 mr-2" /> Refresh rows
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onDropTable} className="text-destructive">
                    <Trash2 className="h-3.5 w-3.5 mr-2" /> Drop table
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
            <div className="border-b border-border px-2">
              <TabsList className="h-9 bg-transparent p-0 gap-1">
                <TabsTrigger value="rows" className="text-xs data-[state=active]:bg-accent">
                  <Rows3 className="h-3.5 w-3.5 mr-1" /> Rows
                </TabsTrigger>
                <TabsTrigger value="schema" className="text-xs data-[state=active]:bg-accent">
                  <Columns className="h-3.5 w-3.5 mr-1" /> Schema
                </TabsTrigger>
                <TabsTrigger value="sql" className="text-xs data-[state=active]:bg-accent">
                  <Database className="h-3.5 w-3.5 mr-1" /> SQL editor
                </TabsTrigger>
                <TabsTrigger value="io" className="text-xs data-[state=active]:bg-accent">
                  <Upload className="h-3.5 w-3.5 mr-1" /> Import / Export
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Rows */}
            <TabsContent value="rows" className="m-0">
              {!active ? (
                <EmptyState msg="Select a table on the left to view rows." />
              ) : (
                <>
                  <div className="px-4 py-2 flex items-center gap-2 flex-wrap border-b border-border">
                    <Input
                      placeholder="Filter rows…"
                      value={filter}
                      onChange={(e) => { setFilter(e.target.value); setPage(0); }}
                      className="h-8 w-48 text-xs"
                    />
                    <div className="text-[11px] text-muted-foreground">
                      {filteredRows.length} / {rows.length}
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => setRowDialog({ mode: "create", row: {} })}>
                        <Plus className="h-3.5 w-3.5 mr-1" /> Insert row
                      </Button>
                    </div>
                  </div>

                  <div className="overflow-x-auto max-h-[calc(100vh-380px)] overflow-y-auto">
                    {loading ? (
                      <div className="p-10 text-center text-muted-foreground text-sm">
                        <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading…
                      </div>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="bg-muted/40 sticky top-0">
                          <tr>
                            {activeTable?.columns.map((c) => (
                              <th key={c.name} className="text-left px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                                <div className="flex items-center gap-1">
                                  {c.pk && <KeyRound className="h-3 w-3 text-primary" />}
                                  <span>{c.name}</span>
                                  <span className="text-[10px] opacity-60">{c.type}</span>
                                </div>
                              </th>
                            ))}
                            <th className="w-16" />
                          </tr>
                        </thead>
                        <tbody>
                          {pagedRows.map((r, i) => (
                            <tr key={i} className="border-t border-border hover:bg-muted/20">
                              {activeTable?.columns.map((c) => (
                                <td key={c.name} className="px-3 py-2 font-mono text-xs max-w-[280px] truncate" title={String(r[c.name] ?? "")}>
                                  {formatCell(r[c.name])}
                                </td>
                              ))}
                              <td className="px-3 py-2 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <button onClick={() => setRowDialog({ mode: "edit", row: r })} className="p-1 text-muted-foreground hover:text-foreground">
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button onClick={() => onDelete(String(r.id))} className="p-1 text-muted-foreground hover:text-destructive">
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                          {!pagedRows.length && (
                            <tr>
                              <td colSpan={(activeTable?.columns.length ?? 0) + 1} className="px-3 py-12 text-center text-sm text-muted-foreground">
                                No rows match.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {pageCount > 1 && (
                    <div className="border-t border-border px-4 py-2 flex items-center justify-between text-xs">
                      <div className="text-muted-foreground">Page {page + 1} / {pageCount}</div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</Button>
                        <Button size="sm" variant="outline" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </TabsContent>

            {/* Schema */}
            <TabsContent value="schema" className="m-0">
              {!activeTable ? (
                <EmptyState msg="Select a table to view its schema." />
              ) : (
                <div>
                  <div className="px-4 py-2 flex items-center justify-between border-b border-border">
                    <div className="text-xs text-muted-foreground">
                      {activeTable.columns.length} columns
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setAddColumn(true)}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> Add column
                    </Button>
                  </div>
                  <div className="overflow-x-auto max-h-[calc(100vh-380px)] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 sticky top-0 text-xs text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Column</th>
                          <th className="text-left px-3 py-2 font-medium">Type</th>
                          <th className="text-left px-3 py-2 font-medium">Nullable</th>
                          <th className="text-left px-3 py-2 font-medium">Key</th>
                          <th className="w-16" />
                        </tr>
                      </thead>
                      <tbody>
                        {activeTable.columns.map((c) => (
                          <tr key={c.name} className="border-t border-border hover:bg-muted/20">
                            <td className="px-3 py-2 font-mono text-xs">{c.name}</td>
                            <td className="px-3 py-2 font-mono text-xs">{c.type}</td>
                            <td className="px-3 py-2 text-xs">
                              {c.nullable ? <Badge variant="secondary" className="text-[10px]">NULL</Badge> : <Badge variant="outline" className="text-[10px]">NOT NULL</Badge>}
                            </td>
                            <td className="px-3 py-2 text-xs">
                              {c.pk && <Badge className="text-[10px]"><KeyRound className="h-3 w-3 mr-1" />PK</Badge>}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {!c.pk && (
                                <button
                                  onClick={() => onDropColumn(c.name)}
                                  className="p-1 text-muted-foreground hover:text-destructive"
                                  title="Drop column"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground flex items-center gap-2">
                    Advanced schema (indexes, foreign keys, constraints, RLS):
                    <Link to="/dashboard/pluto-schema" className="underline underline-offset-2 hover:text-foreground inline-flex items-center gap-1">
                      Open Schema Editor <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              )}
            </TabsContent>

            {/* SQL Editor */}
            <TabsContent value="sql" className="m-0">
              <SqlEditorPanel />
            </TabsContent>

            {/* Import / Export */}
            <TabsContent value="io" className="m-0">
              {!active ? (
                <EmptyState msg="Select a table to import into or export from." />
              ) : (
                <div className="grid md:grid-cols-2 gap-4 p-4">
                  <ImportPanel table={active} onImported={async () => { await refreshRows(active); await refreshTables(); }} />
                  <ExportPanel table={active} rowCount={filteredRows.length} onExport={onExport} />
                </div>
              )}
            </TabsContent>
          </Tabs>
        </section>
      </div>

      {/* Dialogs */}
      {rowDialog && (
        <RowDialog
          mode={rowDialog.mode}
          row={rowDialog.row}
          table={activeTable}
          onClose={() => setRowDialog(null)}
          onSaved={async () => { setRowDialog(null); if (active) await refreshRows(active); }}
        />
      )}
      {createTable && (
        <CreateTableDialog
          onClose={() => setCreateTable(false)}
          onCreated={async (name) => { setCreateTable(false); await refreshTables(); setActive(name); }}
        />
      )}
      {addColumn && activeTable && (
        <AddColumnDialog
          table={activeTable.name}
          onClose={() => setAddColumn(false)}
          onAdded={async () => { setAddColumn(false); await refreshTables(); if (active) await refreshRows(active); }}
        />
      )}
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return <div className="p-12 text-center text-sm text-muted-foreground">{msg}</div>;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ─── Row dialog ───────────────────────────────────────────────────
function RowDialog({ mode, row, table, onClose, onSaved }: {
  mode: "create" | "edit";
  row: Row;
  table: PlutoTable | undefined;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (table?.columns ?? []).map((c) => [c.name, row[c.name] !== undefined && row[c.name] !== null ? (typeof row[c.name] === "object" ? JSON.stringify(row[c.name]) : String(row[c.name])) : ""])
    )
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!table) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const c of table.columns) {
        const raw = values[c.name] ?? "";
        if (raw === "" && c.nullable) { payload[c.name] = null; continue; }
        if (raw === "" && !c.pk) continue;
        payload[c.name] = coerce(raw, c.type);
      }
      if (mode === "create") {
        await pluto.db.insertRow(table.name, payload);
        toast.success("Row inserted");
      } else {
        await pluto.db.updateRow(table.name, String(row.id), payload);
        toast.success("Row updated");
      }
      await onSaved();
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Insert row" : "Edit row"}</DialogTitle>
          <DialogDescription>{table?.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {table?.columns.map((c) => (
            <div key={c.name}>
              <Label className="text-xs flex items-center gap-1">
                {c.name} <span className="text-muted-foreground">({c.type})</span>
                {c.pk && <Badge variant="outline" className="text-[9px]">PK</Badge>}
              </Label>
              <Input
                value={values[c.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))}
                placeholder={c.nullable ? "null" : ""}
                className="font-mono text-xs"
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function coerce(raw: string, type: string): unknown {
  if (type === "integer" || type === "bigint") return Number(raw);
  if (type === "numeric" || type === "float8") return Number(raw);
  if (type === "boolean") return raw === "true" || raw === "1";
  if (type === "jsonb") { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}

// ─── Create table dialog ──────────────────────────────────────────
function CreateTableDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [cols, setCols] = useState<Array<{ name: string; type: string; nullable: boolean; pk: boolean }>>([
    { name: "id", type: "uuid", nullable: false, pk: true },
    { name: "created_at", type: "timestamptz", nullable: false, pk: false },
  ]);
  const [busy, setBusy] = useState(false);

  function addCol() { setCols((c) => [...c, { name: "", type: "text", nullable: true, pk: false }]); }
  function remCol(i: number) { setCols((c) => c.filter((_, j) => j !== i)); }
  function upd(i: number, patch: Partial<typeof cols[0]>) {
    setCols((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  async function submit() {
    if (!name.trim()) return toast.error("Table name required");
    if (!cols.length) return toast.error("At least one column required");
    setBusy(true);
    try {
      await pluto.db.createTable(name.trim(), cols.filter((c) => c.name.trim()));
      toast.success(`Table "${name}" created`);
      await onCreated(name.trim());
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create table</DialogTitle>
          <DialogDescription>Define name and columns. `id` PK and `created_at` are sensible defaults.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Table name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. orders" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs">Columns</Label>
              <Button size="sm" variant="outline" onClick={addCol}>
                <Plus className="h-3 w-3 mr-1" /> Column
              </Button>
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {cols.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_140px_80px_60px_32px] gap-2 items-center">
                  <Input value={c.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="column_name" className="text-xs" />
                  <Select value={c.type} onValueChange={(v) => upd(i, { type: v })}>
                    <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {COLUMN_TYPES.map((t) => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={c.nullable} onChange={(e) => upd(i, { nullable: e.target.checked })} />
                    null
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={c.pk} onChange={(e) => upd(i, { pk: e.target.checked, nullable: false })} />
                    PK
                  </label>
                  <button onClick={() => remCol(i)} className="text-destructive p-1"><X className="h-3.5 w-3.5" /></button>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add column dialog ────────────────────────────────────────────
function AddColumnDialog({ table, onClose, onAdded }: { table: string; onClose: () => void; onAdded: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [nullable, setNullable] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) return toast.error("Column name required");
    setBusy(true);
    try {
      await pluto.db.addColumn(table, { name: name.trim(), type, nullable });
      toast.success("Column added");
      await onAdded();
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add column to {table}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="column_name" />
          </div>
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {COLUMN_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} />
            Nullable
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Import panel (inline) ───────────────────────────────────────
function ImportPanel({ table, onImported }: { table: string; onImported: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const isJson = f.name.endsWith(".json");
    setFormat(isJson ? "json" : "csv");
    f.text().then(setText);
  }

  useEffect(() => {
    if (!text.trim()) { setPreview([]); return; }
    try {
      if (format === "json") {
        const parsed = JSON.parse(text);
        setPreview(Array.isArray(parsed) ? parsed.slice(0, 5) : []);
      } else {
        setPreview(parseCsv(text).rows.slice(0, 5));
      }
    } catch { setPreview([]); }
  }, [text, format]);

  async function submit() {
    setBusy(true);
    try {
      const rows = format === "json"
        ? (JSON.parse(text) as Record<string, unknown>[])
        : parseCsv(text).rows as Record<string, unknown>[];
      if (!Array.isArray(rows) || !rows.length) throw new Error("No rows to import");
      const { inserted } = await pluto.db.importRows(table, rows);
      toast.success(`Imported ${inserted} rows`);
      setText("");
      await onImported();
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-border p-3 min-w-0">
      <div className="text-sm font-medium mb-2 flex items-center gap-2">
        <Upload className="h-4 w-4" /> Import rows → {table}
      </div>
      <div className="flex items-center gap-2 mb-2">
        <input ref={fileRef} type="file" accept=".csv,.json" onChange={onFile} className="hidden" />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          Choose file
        </Button>
        <Select value={format} onValueChange={(v) => setFormat(v as "csv" | "json")}>
          <SelectTrigger className="h-9 w-28 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="csv">CSV</SelectItem>
            <SelectItem value="json">JSON</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={format === "csv" ? "id,name,email\n..." : "[ { \"id\": \"...\" } ]"}
        className="font-mono text-xs h-32"
      />
      {preview.length > 0 && (
        <pre className="mt-2 bg-muted/40 p-2 rounded text-[11px] max-h-32 overflow-auto">{JSON.stringify(preview, null, 2)}</pre>
      )}
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={submit} disabled={busy || !text.trim()}>
          {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Import
        </Button>
      </div>
    </div>
  );
}

// ─── Export panel ────────────────────────────────────────────────
function ExportPanel({ table, rowCount, onExport }: {
  table: string;
  rowCount: number;
  onExport: (fmt: "csv" | "json") => Promise<void>;
}) {
  return (
    <div className="rounded-lg border border-border p-3 min-w-0">
      <div className="text-sm font-medium mb-2 flex items-center gap-2">
        <Download className="h-4 w-4" /> Export {table}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Downloads the currently filtered set ({rowCount} rows).
      </p>
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={() => onExport("csv")}>
          <FileSpreadsheet className="h-3.5 w-3.5 mr-1" /> Download CSV
        </Button>
        <Button size="sm" variant="outline" onClick={() => onExport("json")}>
          <FileJson className="h-3.5 w-3.5 mr-1" /> Download JSON
        </Button>
      </div>
    </div>
  );
}

// ─── SQL editor (inline tab) ─────────────────────────────────────
function SqlEditorPanel() {
  const [sql, setSql] = useState("select now();");
  const [result, setResult] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(SQL_HISTORY_KEY) ?? "[]"); }
    catch { return []; }
  });

  async function run() {
    setBusy(true); setErr(null);
    try {
      const r = await pluto.db.runSql(sql);
      setResult(r);
      const next = [sql, ...history.filter((s) => s !== sql)].slice(0, 20);
      setHistory(next);
      localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(next));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setResult(null);
    } finally { setBusy(false); }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void run(); }
  }

  function clearHistory() {
    setHistory([]);
    localStorage.setItem(SQL_HISTORY_KEY, "[]");
  }

  return (
    <div className="grid md:grid-cols-[minmax(0,1fr)_200px] gap-3 p-4">
      <div className="space-y-3 min-w-0">
        <Textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          className="font-mono text-xs h-40"
          placeholder="select * from ..."
        />
        <div className="flex gap-2 items-center">
          <Button size="sm" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1" />}
            Run
          </Button>
          <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter</span>
          {result && (
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => {
              const rowsObj = result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]])));
              downloadCsv("query-result.csv", rowsToCsv(rowsObj));
            }}>
              <Download className="h-3.5 w-3.5 mr-1" /> CSV
            </Button>
          )}
        </div>
        {err && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded p-2 font-mono whitespace-pre-wrap">
            {err}
          </div>
        )}
        {result && (
          <div className="overflow-auto rounded-md border border-border max-h-72">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>{result.columns.map((c) => <th key={c} className="text-left px-3 py-2 font-medium">{c}</th>)}</tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {row.map((v, j) => <td key={j} className="px-3 py-1.5 font-mono">{formatCell(v)}</td>)}
                  </tr>
                ))}
                {!result.rows.length && (
                  <tr><td colSpan={result.columns.length} className="px-3 py-4 text-center text-muted-foreground">Query returned no rows.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="border-l border-border pl-3 min-w-0">
        <div className="text-xs font-medium mb-2 flex items-center gap-1 text-muted-foreground">
          <History className="h-3.5 w-3.5" /> History
          {history.length > 0 && (
            <button onClick={clearHistory} className="ml-auto text-[10px] hover:text-destructive">clear</button>
          )}
        </div>
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {history.map((h, i) => (
            <button
              key={i}
              onClick={() => setSql(h)}
              className="w-full text-left text-[11px] font-mono p-1.5 rounded hover:bg-accent truncate"
              title={h}
            >
              {h.replace(/\s+/g, " ").slice(0, 40)}
            </button>
          ))}
          {!history.length && <div className="text-xs text-muted-foreground">No history yet.</div>}
        </div>
      </div>
    </div>
  );
}
