import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GitBranch, Play, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { getUpstream, plutoApi, pushUiHistory } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-migrations")({
  component: PlutoMigrationsPage,
});

type Project = { id: string; name: string; slug: string };
type Migration = {
  id: string; project_id: string | null; version: string; name: string;
  up_sql?: string; down_sql?: string; checksum: string;
  applied_at: string | null; rolled_back_at: string | null;
  applied_by: string | null; created_at: string;
  status: "pending" | "applied" | "rolled_back";
};

function StatusBadge({ s }: { s: Migration["status"] }) {
  if (s === "applied")     return <Badge>applied</Badge>;
  if (s === "pending")     return <Badge variant="outline">pending</Badge>;
  return <Badge variant="destructive">rolled back</Badge>;
}

function PlutoMigrationsPage() {
  const { configured } = getUpstream();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [rows, setRows] = useState<Migration[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<Migration | null>(null);

  const [nm, setNm] = useState("");
  const [up, setUp] = useState("");
  const [down, setDown] = useState("");

  async function loadProjects() {
    try {
      const list = await plutoApi<Project[]>("/admin/v1/projects");
      setProjects(list);
    } catch (e: any) { setErr(e.message); }
  }
  async function load() {
    setBusy(true); setErr(null);
    try {
      const qs = new URLSearchParams();
      if (projectId) qs.set("project_id", projectId);
      qs.set("limit", "200");
      setRows(await plutoApi<Migration[]>(`/admin/v1/migrations?${qs}`));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function openView(m: Migration) {
    try {
      const full = await plutoApi<Migration>(`/admin/v1/migrations/${m.id}`);
      setViewing({ ...m, ...full });
    } catch (e: any) { setErr(e.message); }
  }
  async function create() {
    if (!nm || !up) { setErr("name + up_sql required"); return; }
    try {
      await plutoApi("/admin/v1/migrations", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId || undefined, name: nm, up_sql: up, down_sql: down }),
      });
      pushUiHistory({ action: "migration.create", detail: nm, ok: true });
      setNm(""); setUp(""); setDown(""); await load();
    } catch (e: any) { pushUiHistory({ action: "migration.create", detail: e.message, ok: false }); setErr(e.message); }
  }
  async function apply(m: Migration) {
    if (!confirm(`Apply "${m.name}"?`)) return;
    try {
      await plutoApi(`/admin/v1/migrations/${m.id}/apply`, { method: "POST" });
      pushUiHistory({ action: "migration.apply", detail: m.name, ok: true });
      await load();
    } catch (e: any) { pushUiHistory({ action: "migration.apply", detail: e.message, ok: false }); setErr(e.message); }
  }
  async function rollback(m: Migration) {
    if (!confirm(`Rollback "${m.name}"? This runs the down_sql inside a transaction.`)) return;
    try {
      await plutoApi(`/admin/v1/migrations/${m.id}/rollback`, { method: "POST" });
      pushUiHistory({ action: "migration.rollback", detail: m.name, ok: true });
      await load();
    } catch (e: any) {
      pushUiHistory({ action: "migration.rollback", detail: e.message, ok: false });
      setErr(e.body?.newer ? `${e.message} — newer applied migrations block rollback.` : e.message);
    }
  }
  async function del(m: Migration) {
    if (!confirm(`Delete pending migration "${m.name}"?`)) return;
    try {
      await plutoApi(`/admin/v1/migrations/${m.id}`, { method: "DELETE" });
      pushUiHistory({ action: "migration.delete", detail: m.name, ok: true });
      await load();
    } catch (e: any) { pushUiHistory({ action: "migration.delete", detail: e.message, ok: false }); setErr(e.message); }
  }

  useEffect(() => { if (configured) loadProjects(); /* eslint-disable-next-line */ }, [configured]);
  useEffect(() => { if (configured) load(); /* eslint-disable-next-line */ }, [configured, projectId]);

  return (
    <div className="space-y-6">
      <PageHeader title="Pluto Migrations" description="Versioned schema evolution with up/down/rollback." />
      {!configured && <Alert><AlertDescription>Set upstream on the Pluto Admin page first.</AlertDescription></Alert>}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      {configured && (
        <>
          <Card>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end pt-6">
              <div>
                <Label>Project scope</Label>
                <Select value={projectId || "__global__"} onValueChange={(v) => setProjectId(v === "__global__" ? "" : v)}>
                  <SelectTrigger><SelectValue/></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__global__">Global (superadmin)</SelectItem>
                    {projects.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={load} disabled={busy}><RefreshCw className={"h-4 w-4 mr-1 " + (busy ? "animate-spin" : "")}/>Refresh</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Plus className="h-4 w-4"/>New migration</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Input placeholder="Name (e.g. add_users_email_idx)" value={nm} onChange={e => setNm(e.target.value)}/>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div><Label>up_sql</Label><Textarea className="font-mono text-xs min-h-[140px]" value={up} onChange={e => setUp(e.target.value)}/></div>
                <div><Label>down_sql</Label><Textarea className="font-mono text-xs min-h-[140px]" value={down} onChange={e => setDown(e.target.value)}/></div>
              </div>
              <div className="flex justify-end"><Button onClick={create}><Plus className="h-4 w-4 mr-1"/>Create pending</Button></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><GitBranch className="h-4 w-4"/>Timeline</CardTitle></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-left"><tr>
                  <th className="p-2">Version</th><th className="p-2">Name</th><th className="p-2">Status</th>
                  <th className="p-2">Applied</th><th className="p-2 text-right">Actions</th>
                </tr></thead>
                <tbody>
                  {rows.map(m => (
                    <tr key={m.id} className="border-t">
                      <td className="p-2 font-mono">{m.version}</td>
                      <td className="p-2">{m.name}</td>
                      <td className="p-2"><StatusBadge s={m.status}/></td>
                      <td className="p-2">{m.applied_at ? new Date(m.applied_at).toLocaleString() : "—"}</td>
                      <td className="p-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => openView(m)}>View</Button>
                        {m.status !== "applied" && <Button size="sm" variant="outline" onClick={() => apply(m)}><Play className="h-4 w-4 mr-1"/>Apply</Button>}
                        {m.status === "applied" && <Button size="sm" variant="outline" onClick={() => rollback(m)}><RotateCcw className="h-4 w-4 mr-1"/>Rollback</Button>}
                        {m.status !== "applied" && <Button size="sm" variant="ghost" onClick={() => del(m)}><Trash2 className="h-4 w-4 text-destructive"/></Button>}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">No migrations.</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
            <DialogContent className="sm:max-w-3xl">
              <DialogHeader><DialogTitle>{viewing?.name} <Badge variant="outline" className="ml-2 font-mono">{viewing?.version}</Badge></DialogTitle></DialogHeader>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label>up_sql</Label>
                  <pre className="rounded-md border bg-muted/40 p-3 text-xs font-mono max-h-[400px] overflow-auto whitespace-pre-wrap">{viewing?.up_sql}</pre>
                </div>
                <div>
                  <Label>down_sql</Label>
                  <pre className="rounded-md border bg-muted/40 p-3 text-xs font-mono max-h-[400px] overflow-auto whitespace-pre-wrap">{viewing?.down_sql || "(none)"}</pre>
                </div>
              </div>
              <DialogFooter><Button variant="outline" onClick={() => setViewing(null)}>Close</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
