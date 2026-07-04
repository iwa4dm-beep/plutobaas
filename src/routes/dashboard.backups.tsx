import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { backups, branching, isLive, type BackupExport, type BackupRestore, type DbBranch } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Archive, RefreshCw, Play, X, RotateCcw, ShieldAlert, GitBranch } from "lucide-react";
import { toast } from "sonner";

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

  async function refresh() {
    if (!isLive()) return;
    try { const r = await backups.list(); setRows(r.exports); }
    catch (e) { toast.error((e as Error).message); }
  }
  const stopRef = useRef<null | (() => void)>(null);
  useEffect(() => () => { stopRef.current?.(); }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, []);
  useEffect(() => { if (isLive()) branching.list().then(r => setBranches(r.branches)).catch(() => undefined); }, [wizard]);

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
          <div className="space-y-1">
            {rows.map(r => (
              <div key={r.id} className="grid grid-cols-[80px,80px,1fr,100px,180px,140px] gap-2 items-center text-xs p-2 border border-border rounded-md">
                <span>{r.kind}</span>
                <Badge variant={r.status === "done" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>
                <span className="truncate text-muted-foreground">{r.target ?? "*"} {r.download_path && `· ${r.download_path}`} {r.error && `· ${r.error}`}</span>
                <span>{fmtBytes(r.bytes)}</span>
                <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
                <div className="flex gap-1 justify-end">
                  {r.status === "done" && (
                    <Button size="sm" variant="outline" onClick={() => { setWizard(r); setDryRun(true); setConfirm(""); setRestore(null); setRestoreLog(""); }}>
                      <RotateCcw className="h-3 w-3 mr-1" /> Restore
                    </Button>
                  )}
                  {(r.status === "pending" || r.status === "running") && (
                    <Button size="sm" variant="ghost" onClick={() => cancel(r.id)}><X className="h-3 w-3" /></Button>
                  )}
                </div>
              </div>
            ))}
            {rows.length === 0 && <div className="text-xs text-muted-foreground">No exports yet.</div>}
          </div>
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
                <input type="checkbox" checked={allowIncompat} onChange={e => setAllowIncompat(e.target.checked)} />
                Allow restore over incompatible schema (skips safety check)
              </label>
            </div>

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
              <Button size="sm" onClick={beginRestore} disabled={restore?.status === "running" || restore?.status === "pending"}>
                <Play className="h-4 w-4 mr-1" /> {dryRun ? "Run dry-run" : "Apply restore"}
              </Button>
              {restore && restore.status !== "done" && restore.status !== "failed" && (
                <Button size="sm" variant="ghost" onClick={async () => { await backups.cancelRestore(restore.id); }}>Cancel</Button>
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
