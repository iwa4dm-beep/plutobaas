import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { backups, isLive, type BackupExport } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Archive, RefreshCw, Play, X } from "lucide-react";
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

  async function refresh() {
    if (!isLive()) return;
    try { const r = await backups.list(); setRows(r.exports); }
    catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, []);

  async function start() {
    try { await backups.start(kind, target || undefined); toast.success("Export started"); setTarget(""); refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function cancel(id: string) { await backups.cancel(id); refresh(); }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Archive className="h-5 w-5" /> Backups & exports</h1>
          <p className="text-sm text-muted-foreground">Create schema / table / full exports for this workspace.</p>
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
              <div key={r.id} className="grid grid-cols-[80px,80px,1fr,100px,180px,60px] gap-2 items-center text-xs p-2 border border-border rounded-md">
                <span>{r.kind}</span>
                <Badge variant={r.status === "done" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>
                <span className="truncate text-muted-foreground">{r.target ?? "*"} {r.download_path && `· ${r.download_path}`} {r.error && `· ${r.error}`}</span>
                <span>{fmtBytes(r.bytes)}</span>
                <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
                <span>
                  {(r.status === "pending" || r.status === "running") && (
                    <Button size="sm" variant="ghost" onClick={() => cancel(r.id)}><X className="h-3 w-3" /></Button>
                  )}
                </span>
              </div>
            ))}
            {rows.length === 0 && <div className="text-xs text-muted-foreground">No exports yet.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
