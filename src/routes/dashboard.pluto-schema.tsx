import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardPlutoSchemaHelp } from "@/content/help/dashboard.pluto-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { getUpstream, plutoApi, pushUiHistory } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-schema")({
  component: PlutoSchemaPage,
});

type Project = { id: string; name: string; slug: string };
type Index = { name: string; definition: string };
type Constraint = { name: string; type: string; definition: string };

function PlutoSchemaPage() {
  const { configured } = getUpstream();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [schema, setSchema] = useState("public");
  const [table, setTable] = useState("");
  const [indexes, setIndexes] = useState<Index[]>([]);
  const [constraints, setConstraints] = useState<Constraint[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New index
  const [idxName, setIdxName] = useState("");
  const [idxCols, setIdxCols] = useState("");
  const [idxMethod, setIdxMethod] = useState<"btree" | "gin" | "gist" | "hash" | "brin">("btree");
  const [idxUnique, setIdxUnique] = useState(false);
  const [idxWhere, setIdxWhere] = useState("");

  // New constraint
  const [cType, setCType] = useState<"unique" | "check" | "not_null" | "foreign_key">("unique");
  const [cName, setCName] = useState("");
  const [cCols, setCCols] = useState("");
  const [cExpr, setCExpr] = useState("");
  const [cColumn, setCColumn] = useState("");
  const [cRefSchema, setCRefSchema] = useState("public");
  const [cRefTable, setCRefTable] = useState("");
  const [cRefCols, setCRefCols] = useState("");

  async function loadProjects() {
    try {
      const list = await plutoApi<Project[]>("/admin/v1/projects");
      setProjects(list);
      if (list.length && !projectId) setProjectId(list[0].id);
    } catch (e: any) { setErr(e.message); }
  }
  async function loadTable() {
    if (!table) return;
    setErr(null); setBusy(true);
    try {
      const [ix, co] = await Promise.all([
        plutoApi<Index[]>(`/admin/v1/schema/tables/${schema}/${table}/indexes`),
        plutoApi<Constraint[]>(`/admin/v1/schema/tables/${schema}/${table}/constraints`),
      ]);
      setIndexes(ix); setConstraints(co);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function createIndex() {
    if (!projectId || !table || !idxName || !idxCols.trim()) { setErr("project + table + name + columns required"); return; }
    setBusy(true); setErr(null);
    const columns = idxCols.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await plutoApi("/admin/v1/schema/indexes", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId, schema, table, name: idxName, columns,
          method: idxMethod, unique: idxUnique, where: idxWhere || undefined,
        }),
      });
      pushUiHistory({ action: "schema.index.create", detail: `${schema}.${table} ${idxName}`, ok: true });
      setIdxName(""); setIdxCols(""); setIdxWhere(""); setIdxUnique(false);
      await loadTable();
    } catch (e: any) {
      pushUiHistory({ action: "schema.index.create", detail: e.message, ok: false });
      setErr(e.message);
    } finally { setBusy(false); }
  }
  async function dropIndex(name: string) {
    if (!confirm(`Drop index ${name}?`)) return;
    try {
      const qs = new URLSearchParams({ project_id: projectId, schema, name });
      await plutoApi(`/admin/v1/schema/indexes?${qs}`, { method: "DELETE" });
      pushUiHistory({ action: "schema.index.drop", detail: name, ok: true });
      await loadTable();
    } catch (e: any) { pushUiHistory({ action: "schema.index.drop", detail: e.message, ok: false }); setErr(e.message); }
  }
  async function createConstraint() {
    if (!projectId || !table) { setErr("project + table required"); return; }
    setBusy(true); setErr(null);
    try {
      let body: any = { type: cType, project_id: projectId, schema, table };
      if (cType === "unique")  body = { ...body, name: cName, columns: cCols.split(",").map(s => s.trim()).filter(Boolean) };
      if (cType === "check")   body = { ...body, name: cName, expression: cExpr };
      if (cType === "not_null")body = { ...body, column: cColumn };
      if (cType === "foreign_key") body = {
        ...body, name: cName,
        columns: cCols.split(",").map(s => s.trim()).filter(Boolean),
        ref_schema: cRefSchema, ref_table: cRefTable,
        ref_columns: cRefCols.split(",").map(s => s.trim()).filter(Boolean),
      };
      await plutoApi("/admin/v1/schema/constraints", { method: "POST", body: JSON.stringify(body) });
      pushUiHistory({ action: `schema.constraint.${cType}`, detail: `${schema}.${table}`, ok: true });
      setCName(""); setCCols(""); setCExpr(""); setCColumn(""); setCRefTable(""); setCRefCols("");
      await loadTable();
    } catch (e: any) {
      pushUiHistory({ action: `schema.constraint.${cType}`, detail: e.message, ok: false });
      setErr(e.message);
    } finally { setBusy(false); }
  }
  async function dropConstraint(name: string) {
    if (!confirm(`Drop constraint ${name}?`)) return;
    try {
      const qs = new URLSearchParams({ project_id: projectId, schema, table, name });
      await plutoApi(`/admin/v1/schema/constraints?${qs}`, { method: "DELETE" });
      pushUiHistory({ action: "schema.constraint.drop", detail: name, ok: true });
      await loadTable();
    } catch (e: any) { pushUiHistory({ action: "schema.constraint.drop", detail: e.message, ok: false }); setErr(e.message); }
  }

  useEffect(() => { if (configured) loadProjects(); /* eslint-disable-next-line */ }, [configured]);

  return (
    <div className="space-y-6">
      <PageHeader title="Pluto Schema" description="Manage indexes and constraints (btree/gin/gist/hash/brin, unique/check/not-null/foreign-key)." />
      <HelpPanel help={dashboardPlutoSchemaHelp} />
      {!configured && <Alert><AlertDescription>Set upstream on the Pluto Admin page first.</AlertDescription></Alert>}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      {configured && (
        <>
          <Card>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end pt-6">
              <div>
                <Label>Project</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger><SelectValue placeholder="Select"/></SelectTrigger>
                  <SelectContent>{projects.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Schema</Label><Input value={schema} onChange={e => setSchema(e.target.value)}/></div>
              <div><Label>Table</Label><Input placeholder="users" value={table} onChange={e => setTable(e.target.value)}/></div>
              <Button onClick={loadTable} disabled={busy || !table}><RefreshCw className={"h-4 w-4 mr-1 " + (busy ? "animate-spin" : "")}/>Load</Button>
            </CardContent>
          </Card>

          {table && (
            <Tabs defaultValue="indexes">
              <TabsList>
                <TabsTrigger value="indexes">Indexes</TabsTrigger>
                <TabsTrigger value="constraints">Constraints</TabsTrigger>
              </TabsList>

              <TabsContent value="indexes" className="space-y-3 pt-3">
                <Card>
                  <CardHeader><CardTitle className="text-sm">Add index</CardTitle></CardHeader>
                  <CardContent className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
                    <div><Label>Name</Label><Input value={idxName} onChange={e => setIdxName(e.target.value)}/></div>
                    <div className="md:col-span-2"><Label>Columns (comma-sep)</Label><Input value={idxCols} onChange={e => setIdxCols(e.target.value)} placeholder="email"/></div>
                    <div>
                      <Label>Method</Label>
                      <Select value={idxMethod} onValueChange={(v) => setIdxMethod(v as any)}>
                        <SelectTrigger><SelectValue/></SelectTrigger>
                        <SelectContent>{["btree","gin","gist","hash","brin"].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2 pb-2"><Switch checked={idxUnique} onCheckedChange={setIdxUnique}/><Label className="text-xs">unique</Label></div>
                    <Button onClick={createIndex} disabled={busy}><Plus className="h-4 w-4 mr-1"/>Create</Button>
                    <div className="md:col-span-6"><Label>WHERE (optional, partial index)</Label><Input value={idxWhere} onChange={e => setIdxWhere(e.target.value)} placeholder="active = true"/></div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-0">
                    <ul className="divide-y">
                      {indexes.map(ix => (
                        <li key={ix.name} className="p-3 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-mono text-sm">{ix.name}</div>
                            <div className="text-xs text-muted-foreground font-mono break-all">{ix.definition}</div>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => dropIndex(ix.name)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                        </li>
                      ))}
                      {indexes.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">No indexes.</li>}
                    </ul>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="constraints" className="space-y-3 pt-3">
                <Card>
                  <CardHeader><CardTitle className="text-sm">Add constraint</CardTitle></CardHeader>
                  <CardContent className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
                    <div>
                      <Label>Type</Label>
                      <Select value={cType} onValueChange={(v) => setCType(v as any)}>
                        <SelectTrigger><SelectValue/></SelectTrigger>
                        <SelectContent>{["unique","check","not_null","foreign_key"].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    {cType !== "not_null" && <div><Label>Name</Label><Input value={cName} onChange={e => setCName(e.target.value)}/></div>}
                    {cType === "unique" && <div className="md:col-span-3"><Label>Columns</Label><Input value={cCols} onChange={e => setCCols(e.target.value)} placeholder="email"/></div>}
                    {cType === "check" && <div className="md:col-span-3"><Label>Expression</Label><Input value={cExpr} onChange={e => setCExpr(e.target.value)} placeholder="age &gt; 0"/></div>}
                    {cType === "not_null" && <div className="md:col-span-4"><Label>Column</Label><Input value={cColumn} onChange={e => setCColumn(e.target.value)} placeholder="email"/></div>}
                    {cType === "foreign_key" && (
                      <>
                        <div><Label>Columns</Label><Input value={cCols} onChange={e => setCCols(e.target.value)} placeholder="user_id"/></div>
                        <div><Label>Ref schema</Label><Input value={cRefSchema} onChange={e => setCRefSchema(e.target.value)}/></div>
                        <div><Label>Ref table</Label><Input value={cRefTable} onChange={e => setCRefTable(e.target.value)}/></div>
                        <div><Label>Ref columns</Label><Input value={cRefCols} onChange={e => setCRefCols(e.target.value)} placeholder="id"/></div>
                      </>
                    )}
                    <Button onClick={createConstraint} disabled={busy}><Plus className="h-4 w-4 mr-1"/>Add</Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-0">
                    <ul className="divide-y">
                      {constraints.map(c => (
                        <li key={c.name} className="p-3 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-mono text-sm flex items-center gap-2">{c.name} <Badge variant="outline">{c.type}</Badge></div>
                            <div className="text-xs text-muted-foreground font-mono break-all">{c.definition}</div>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => dropConstraint(c.name)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                        </li>
                      ))}
                      {constraints.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">No constraints.</li>}
                    </ul>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </>
      )}
    </div>
  );
}
