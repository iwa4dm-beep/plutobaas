import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Download, History, RefreshCw, Trash2 } from "lucide-react";
import { getUpstream, plutoApi, readUiHistory, clearUiHistory } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-audit")({
  component: PlutoAuditPage,
});

type Row = {
  id: string; actor_id: string | null; project_id: string | null;
  action: string; resource_type: string; resource_id: string | null;
  params: any; result: "ok" | "error" | "blocked"; duration_ms: number | null;
  error_message: string | null; created_at: string;
};

function PlutoAuditPage() {
  const { configured } = getUpstream();
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [projectId, setProjectId] = useState("");
  const [since, setSince] = useState("");
  const [uiHist, setUiHist] = useState(() => readUiHistory());

  async function load() {
    setBusy(true); setErr(null);
    try {
      const qs = new URLSearchParams();
      if (action) qs.set("action", action);
      if (projectId) qs.set("project_id", projectId);
      if (since) qs.set("since", new Date(since).toISOString());
      qs.set("limit", "200");
      setRows(await plutoApi<Row[]>(`/admin/v1/audit?${qs}`));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => { if (configured) load(); /* eslint-disable-next-line */ }, [configured]);

  function exportCsv() {
    const header = ["created_at","actor_id","project_id","action","resource_type","resource_id","result","duration_ms","error_message"];
    const lines = [header.join(",")].concat(
      rows.map(r => header.map(h => JSON.stringify((r as any)[h] ?? "")).join(","))
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pluto-audit-${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  const totalOk = useMemo(() => rows.filter(r => r.result === "ok").length, [rows]);
  const totalBlocked = useMemo(() => rows.filter(r => r.result === "blocked").length, [rows]);
  const totalErr = useMemo(() => rows.filter(r => r.result === "error").length, [rows]);

  return (
    <div className="space-y-6">
      <PageHeader title="Pluto Audit" description="Timestamped log of every admin, CRUD, SQL, storage and migration action." />

      {!configured && <Alert><AlertDescription>Set upstream on the Pluto Admin page first.</AlertDescription></Alert>}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      {configured && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-sm">Filters</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
              <div><Label>Action</Label><Input placeholder="sql.exec" value={action} onChange={e => setAction(e.target.value)}/></div>
              <div><Label>Project ID</Label><Input placeholder="uuid" value={projectId} onChange={e => setProjectId(e.target.value)}/></div>
              <div><Label>Since</Label><Input type="datetime-local" value={since} onChange={e => setSince(e.target.value)}/></div>
              <div className="flex gap-2">
                <Button onClick={load} disabled={busy}><RefreshCw className={"h-4 w-4 mr-1 " + (busy ? "animate-spin" : "")}/>Refresh</Button>
                <Button variant="outline" onClick={exportCsv} disabled={!rows.length}><Download className="h-4 w-4 mr-1"/>CSV</Button>
              </div>
              <div>
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" onClick={() => setUiHist(readUiHistory())}><History className="h-4 w-4 mr-1"/>UI history</Button>
                  </SheetTrigger>
                  <SheetContent side="right" className="w-[420px] sm:max-w-[420px]">
                    <SheetHeader><SheetTitle>Session UI history</SheetTitle></SheetHeader>
                    <div className="mt-4 space-y-2 max-h-[80vh] overflow-auto">
                      {uiHist.length === 0 && <div className="text-sm text-muted-foreground">Nothing yet.</div>}
                      {uiHist.map((h, i) => (
                        <div key={i} className="text-xs border rounded-md p-2">
                          <div className="flex items-center justify-between">
                            <span className="font-mono">{h.action}</span>
                            <Badge variant={h.ok ? "default" : "destructive"} className="text-[10px]">{h.ok ? "ok" : "fail"}</Badge>
                          </div>
                          {h.detail && <div className="mt-1 text-muted-foreground break-all">{h.detail}</div>}
                          <div className="mt-1 text-muted-foreground">{new Date(h.ts).toLocaleString()}</div>
                        </div>
                      ))}
                      {uiHist.length > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => { clearUiHistory(); setUiHist([]); }}>
                          <Trash2 className="h-4 w-4 mr-1"/>Clear
                        </Button>
                      )}
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-2 text-xs">
            <Badge variant="secondary">ok: {totalOk}</Badge>
            <Badge variant="outline">blocked: {totalBlocked}</Badge>
            <Badge variant="destructive">error: {totalErr}</Badge>
            <span className="text-muted-foreground">total {rows.length}</span>
          </div>

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="p-2">Time</th><th className="p-2">Action</th><th className="p-2">Resource</th>
                    <th className="p-2">Result</th><th className="p-2">Duration</th><th className="p-2">Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <>
                      <tr key={r.id} className="border-t hover:bg-muted/30 cursor-pointer" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                        <td className="p-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                        <td className="p-2 font-mono">{r.action}</td>
                        <td className="p-2">{r.resource_type}{r.resource_id ? `:${r.resource_id.slice(0, 12)}` : ""}</td>
                        <td className="p-2">
                          <Badge variant={r.result === "ok" ? "default" : r.result === "blocked" ? "outline" : "destructive"}>{r.result}</Badge>
                        </td>
                        <td className="p-2">{r.duration_ms ?? "—"} ms</td>
                        <td className="p-2 font-mono">{r.actor_id?.slice(0, 8) ?? "—"}</td>
                      </tr>
                      {expanded === r.id && (
                        <tr className="bg-muted/20"><td colSpan={6} className="p-3">
                          <pre className="text-[11px] whitespace-pre-wrap break-all font-mono">{JSON.stringify(r.params, null, 2)}</pre>
                          {r.error_message && <div className="mt-2 text-destructive text-[11px]">Error: {r.error_message}</div>}
                        </td></tr>
                      )}
                    </>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No audit rows.</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
