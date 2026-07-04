import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { backups, branching, isLive, type BackupExport, type BackupRestore, type DbBranch, type BackupCompat } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Archive, RefreshCw, Play, X, RotateCcw, ShieldAlert, GitBranch, Diff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PaginatedTable } from "@/components/pluto/PaginatedTable";
import { usePaginatedTable } from "@/lib/pluto/usePaginatedTable";

export const Route = createFileRoute("/dashboard/backups")({ component: BackupsPage });

function fmtBytes(n: number) {
  if (!n) return "0 B";
  const u = ["B","KB","MB","GB","TB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function BackupsPage() {
  const [rows, setRows] = useState<BackupExport[]>([]);
  const [kind, setKind] = useState<"full"|"schema"|"table">("full");
  const [target, setTarget] = useState("");
  const [wizard, setWizard] = useState<BackupExport | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [confirm, setConfirm] = useState("");
  const [restore, setRestore] = useState<(BackupRestore & { target_schema?: string | null; target_branch_id?: string | null }) | null>(null);
  const [restoreLog, setRestoreLog] = useState<string>("");
  const [branches, setBranches] = useState<DbBranch[]>([]);
  const [targetMode, setTargetMode] = useState<"existing"|"new"|"inplace">("inplace");
  const [targetBranchId, setTargetBranchId] = useState<string>("");
  const [newBranchName, setNewBranchName] = useState<string>("");
  const [allowIncompat, setAllowIncompat] = useState(false);
  const [compat, setCompat] = useState<BackupCompat | null>(null);
  const [compatLoading, setCompatLoading] = useState(false);
  const [compatAck, setCompatAck] = useState(false);

  async function refresh() {
    if (!isLive()) return;
    try { const r = await backups.list(); setRows(r.exports); }
    catch (e) { toast.error((e as Error).message); }
  }
  const stopRef = useRef<null | (() => void)>(null);
  useEffect(() => () => { stopRef.current?.(); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, []);
  useEffect(() => { if (isLive()) branching.list().then(r => setBranches(r.branches)).catch(() => undefined); }, [wizard]);

  // Reset compatibility diff when the target changes so stale results don't
  // authorise a restore against a different branch.
  useEffect(() => { setCompat(null); setCompatAck(false); }, [wizard?.id, targetMode, targetBranchId, newBranchName]);

  async function loadCompat() {
    if (!wizard) return;
    setCompatLoading(true);
    try {
      const c = await backups.compat(wizard.id, {
        target_branch_id: targetMode === "existing" ? targetBranchId : undefined,
      });
      setCompat(c); setCompatAck(false);
    } catch (e) { toast.error((e as Error).message); }
    finally { setCompatLoading(false); }
  }

  async function start() {
    try { await backups.start(kind, target || undefined); toast.success("Export started"); setTarget(""); refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function cancel(id: string) { await backups.cancel(id); refresh(); }

  async function beginRestore() {
    if (!wizard) return;
    if (!dryRun && confirm !== "RESTORE") { toast.error("Type RESTORE to confirm live restore."); return; }
    if (targetMode === "existing" && !targetBranchId) { toast.error("Pick a target branch."); return; }
    if (targetMode === "new" && !/^[a-z_][a-z0-9_]{0,40}$/i.test(newBranchName)) { toast.error("Enter a valid branch name."); return; }
    try {
      stopRef.current?.(); stopRef.current = null;
      const r = await backups.startRestore(wizard.id, {
        dry_run: dryRun, confirm: dryRun ? undefined : confirm,
        target_branch_id: targetMode === "existing" ? targetBranchId : undefined,
        create_branch: targetMode === "new" ? newBranchName : undefined,
        allow_incompatible: allowIncompat,
      });
      setRestore(r.restore); setRestoreLog("");
      const stop = backups.streamRestore(r.restore.id, {
        onEvent: (ev) => {
          setRestore(prev => prev ? { ...prev, ...ev } : ev);
          if (ev.log) setRestoreLog(ev.log);
          if (ev.status === "done") { toast.success("Restore complete"); stopRef.current?.(); stopRef.current = null; }
          if (ev.status === "failed") { toast.error(`Restore failed: ${ev.error ?? ""}`); stopRef.current?.(); stopRef.current = null; }
        },
        onError: (e) => toast.error(e.message),
      });
      stopRef.current = stop;
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Archive className="h-5 w-5" /> Backups & restore</h1>
          <p className="text-sm text-muted-foreground">Create schema / table / full exports and restore with dry-run previews.</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">New export</CardTitle></CardHeader>
        <CardContent className="flex gap-2 items-center">
          <select className="h-9 px-3 rounded-md border border-border bg-background text-sm"
                  value={kind} onChange={e => setKind(e.target.value as "full"|"schema"|"table")}>
            <option value="full">full</option><option value="schema">schema</option><option value="table">table</option>
          </select>
          <Input placeholder="target (schema or table name)" value={target} onChange={e => setTarget(e.target.value)} disabled={kind==="full"} />
          <Button size="sm" onClick={start}><Play className="h-4 w-4 mr-1" /> Start</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Recent exports</CardTitle></CardHeader>
        <CardContent>
          <ExportsTable rows={rows}
            onRestore={(r) => { setWizard(r); setDryRun(true); setConfirm(""); setRestore(null); setRestoreLog(""); }}
            onCancel={cancel} />
        </CardContent>
      </Card>

      {wizard && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2"><RotateCcw className="h-4 w-4" /> Restore wizard — {wizard.kind}{wizard.target ? `:${wizard.target}` : ""}</span>
              <Button size="sm" variant="ghost" onClick={() => { stopRef.current?.(); stopRef.current = null; setWizard(null); setRestore(null); }}><X className="h-4 w-4" /></Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Source: <span className="font-mono">{wizard.download_path}</span> · {fmtBytes(wizard.bytes)}
            </div>

            <div className="space-y-2 p-3 rounded-md border border-border">
              <div className="text-xs font-medium flex items-center gap-1"><GitBranch className="h-3 w-3" /> Restore target</div>
              <div className="flex gap-3 text-xs">
                {(["inplace","existing","new"] as const).map(m => (
                  <label key={m} className="flex items-center gap-1">
                    <input type="radio" checked={targetMode===m} onChange={() => setTargetMode(m)} />
                    {m === "inplace" ? "In-place" : m === "existing" ? "Existing branch" : "New branch"}
                  </label>
                ))}
              </div>
              {targetMode === "existing" && (
                <select value={targetBranchId} onChange={e => setTargetBranchId(e.target.value)}
                        className="w-full h-8 text-xs px-2 rounded-md border border-border bg-background">
                  <option value="">Pick branch…</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name} ({b.schema_name})</option>)}
                </select>
              )}
              {targetMode === "new" && (
                <Input placeholder="new-branch-name" value={newBranchName} onChange={e => setNewBranchName(e.target.value)} />
              )}
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <input type="checkbox" checked={allowIncompat}
                       disabled={!!(compat && !compat.compatible && !compatAck)}
                       onChange={e => setAllowIncompat(e.target.checked)} />
                Allow restore over incompatible schema (skips safety check)
                {compat && !compat.compatible && !compatAck && <span className="text-destructive">— review diff first</span>}
              </label>
            </div>

            <CompatibilityPanel compat={compat} loading={compatLoading} onLoad={loadCompat}
              ack={compatAck} onAck={() => setCompatAck(true)} />

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
              Dry-run preview (log statements without applying)
            </label>
            {!dryRun && (
              <div className="p-3 rounded-md bg-destructive/10 border border-destructive/40 space-y-2">
                <div className="flex items-center gap-2 text-sm"><ShieldAlert className="h-4 w-4 text-destructive" /> Live restore will overwrite target objects. Type <span className="font-mono">RESTORE</span> to confirm.</div>
                <Input placeholder="RESTORE" value={confirm} onChange={e => setConfirm(e.target.value)} />
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" data-testid="restore-apply" onClick={beginRestore}
                disabled={restore?.status === "running" || restore?.status === "pending"
                          || (!dryRun && compat != null && !compat.compatible && !compatAck)}>
                <Play className="h-4 w-4 mr-1" /> {dryRun ? "Run dry-run" : "Apply restore"}
              </Button>
              {restore && restore.status !== "done" && restore.status !== "failed" && (
                <Button size="sm" variant="ghost" data-testid="restore-cancel" onClick={async () => { await backups.cancelRestore(restore.id); }}>Cancel</Button>
              )}
            </div>
            {restore && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant={restore.status === "done" ? "default" : restore.status === "failed" ? "destructive" : "secondary"}>{restore.status}</Badge>
                  <span>{restore.applied_statements}/{restore.total_statements} statements</span>
                  <span className="text-muted-foreground">{restore.dry_run ? "DRY-RUN" : "LIVE"}</span>
                </div>
                <Progress value={restore.progress} />
                <pre className="text-[10px] font-mono max-h-[240px] overflow-auto p-2 rounded-md bg-muted whitespace-pre-wrap">{restoreLog || "waiting…"}</pre>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ExportsTable({ rows, onRestore, onCancel }: {
  rows: BackupExport[];
  onRestore: (r: BackupExport) => void;
  onCancel: (id: string) => Promise<void>;
}) {
  const t = usePaginatedTable(rows, { pageSize: 15, defaultSort: { key: "created_at", dir: "desc" } });
  return (
    <PaginatedTable
      rows={t.rows} sorted={t.sorted}
      page={t.page} pageSize={t.pageSize} totalPages={t.totalPages}
      sortKey={t.sortKey} sortDir={t.sortDir}
      onPage={t.setPage} onSort={t.toggleSort}
      csvFilename="backup-exports.csv"
      csvColumns={["created_at","kind","status","target","bytes","download_path","error"]}
      columns={[
        { key: "kind", label: "kind", className: "w-20" },
        { key: "status", label: "status", className: "w-24",
          render: (r) => <Badge variant={r.status === "done" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge> },
        { key: "target", label: "target / path",
          render: (r) => <span className="truncate text-muted-foreground">{r.target ?? "*"}{r.download_path ? ` · ${r.download_path}` : ""}{r.error ? ` · ${r.error}` : ""}</span> },
        { key: "bytes", label: "size", className: "w-24",
          render: (r) => <span>{fmtBytes(r.bytes)}</span> },
        { key: "created_at", label: "created", className: "w-44",
          render: (r) => <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span> },
        { key: "id", label: "", className: "w-32",
          render: (r) => (
            <div className="flex gap-1 justify-end">
              {r.status === "done" && (
                <Button size="sm" variant="outline" onClick={() => onRestore(r)}>
                  <RotateCcw className="h-3 w-3 mr-1" /> Restore
                </Button>
              )}
              {(r.status === "pending" || r.status === "running") && (
                <Button size="sm" variant="ghost" onClick={() => onCancel(r.id)}><X className="h-3 w-3" /></Button>
              )}
            </div>
          ) },
      ]}
      empty="No exports yet."
    />
  );
}

function CompatibilityPanel({ compat, loading, onLoad, ack, onAck }: {
  compat: BackupCompat | null; loading: boolean;
  onLoad: () => Promise<void> | void;
  ack: boolean; onAck: () => void;
}) {
  return (
    <div className="space-y-2 p-3 rounded-md border border-border" data-testid="compat-panel">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium flex items-center gap-1"><Diff className="h-3 w-3" /> Schema compatibility</div>
        <Button size="sm" variant="outline" onClick={() => void onLoad()} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Diff className="h-3 w-3 mr-1" />}
          {compat ? "Re-check" : "Check compatibility"}
        </Button>
      </div>
      {!compat && !loading && (
        <div className="text-[11px] text-muted-foreground">
          Compare the export's DDL against the target schema before you apply.
        </div>
      )}
      {compat && (
        <div className="space-y-2 text-[11px]">
          <div className="flex flex-wrap gap-2">
            <Badge variant={compat.compatible ? "default" : "destructive"}>
              {compat.compatible ? "compatible" : "incompatible"}
            </Badge>
            <span className="text-muted-foreground">target: <span className="font-mono">{compat.target_schema}</span></span>
            <span className="text-muted-foreground">source: {compat.source_tables} tables · target: {compat.target_tables} tables</span>
          </div>
          {compat.added_tables.length > 0 && (
            <div><span className="font-medium text-emerald-600">+ tables to create:</span> <span className="font-mono">{compat.added_tables.join(", ")}</span></div>
          )}
          {compat.removed_tables.length > 0 && (
            <div><span className="font-medium text-destructive">− tables in target not in export:</span> <span className="font-mono">{compat.removed_tables.join(", ")}</span></div>
          )}
          {compat.columns.length > 0 && (
            <div className="overflow-hidden border border-border rounded">
              <div className="grid grid-cols-[60px,1fr,1fr,120px,120px] gap-2 bg-muted/40 px-2 py-1 text-[10px] font-medium">
                <span>action</span><span>table</span><span>column</span><span>source</span><span>target</span>
              </div>
              <div className="max-h-[220px] overflow-y-auto">
                {compat.columns.map((c, i) => (
                  <div key={i} className="grid grid-cols-[60px,1fr,1fr,120px,120px] gap-2 px-2 py-1 border-t border-border">
                    <Badge variant={c.action === "add" ? "default" : c.action === "drop" ? "destructive" : "secondary"}>{c.action}</Badge>
                    <span className="font-mono truncate">{c.table}</span>
                    <span className="font-mono truncate">{c.column}</span>
                    <span className="text-muted-foreground truncate">{c.source_type ?? "—"}</span>
                    <span className="text-muted-foreground truncate">{c.target_type ?? "—"}{c.nullable_change ? ` (${c.nullable_change})` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!compat.compatible && !ack && (
            <label className="flex items-center gap-2 text-[11px]">
              <input type="checkbox" onChange={onAck} data-testid="compat-ack" />
              I've reviewed the diff and want to proceed anyway.
            </label>
          )}
          {!compat.compatible && ack && (
            <div className="text-[11px] text-amber-600">Acknowledged — you may now enable "Allow restore over incompatible schema" and apply.</div>
          )}
        </div>
      )}
    </div>
  );
}
