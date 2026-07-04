import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { edgeV2, isLive, type FnSecret, type FnSchedule, type FnInvocation, type FnCatalog } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Clock, ScrollText, Plus, RefreshCw, Trash2, Play, Pause, Boxes, Zap } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/functions")({ component: FunctionsPage });

function FunctionsPage() {
  const [tab, setTab] = useState<"functions"|"secrets"|"schedules"|"logs">("functions");
  const [slug, setSlug] = useState("hello");
  const [functions, setFunctions] = useState<FnCatalog[]>([]);
  const [secrets, setSecrets] = useState<FnSecret[]>([]);
  const [schedules, setSchedules] = useState<FnSchedule[]>([]);
  const [invos, setInvos] = useState<FnInvocation[]>([]);
  const [secName, setSecName] = useState(""); const [secVal, setSecVal] = useState("");
  const [cron, setCron] = useState("*/5 * * * *");
  const [newSlug, setNewSlug] = useState(""); const [newName, setNewName] = useState("");
  const [runtime, setRuntime] = useState<"node20"|"deno1"|"bun1">("node20");
  const [invokePayload, setInvokePayload] = useState<string>('{"hello":"world"}');
  const [invokeResult, setInvokeResult] = useState<{ status_code: number; duration_ms: number; echoed: unknown; error: { message: string; type?: string; stack?: string } | null } | null>(null);
  const [invokeErr, setInvokeErr] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [invoking, setInvoking] = useState(false);
  const jsonErr = (() => { if (!invokePayload.trim()) return null; try { JSON.parse(invokePayload); return null; } catch (e) { return (e as Error).message; } })();

  async function refresh() {
    if (!isLive()) return;
    try {
      const [f, s, sc, iv] = await Promise.all([
        edgeV2.functions(), edgeV2.secrets(slug), edgeV2.schedules(), edgeV2.invocations(slug, 100),
      ]);
      setFunctions(f.functions); setSecrets(s.secrets); setSchedules(sc.schedules); setInvos(iv.invocations);
    } catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => { refresh(); }, [slug]);

  async function addSecret() {
    if (!secName.trim() || !secVal.trim()) return;
    try { await edgeV2.setSecret(slug, secName.trim(), secVal); setSecName(""); setSecVal(""); toast.success("Secret saved"); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function addSchedule() {
    try { await edgeV2.createSchedule(slug, cron.trim()); toast.success("Schedule added"); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function createFn() {
    if (!newSlug.trim()) return;
    try {
      await edgeV2.upsertFunction({ slug: newSlug.trim(), display_name: newName.trim() || undefined, runtime });
      setNewSlug(""); setNewName(""); toast.success("Function saved"); await refresh();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function invoke() {
    setInvokeErr(null);
    if (jsonErr) { setInvokeErr(`Invalid JSON: ${jsonErr}`); toast.error("Fix payload JSON first"); return; }
    setInvoking(true);
    try {
      const body = invokePayload.trim() ? JSON.parse(invokePayload) : {};
      const r = await edgeV2.invoke(slug, body); setInvokeResult(r);
      if (r.error) { setInvokeErr(`${r.error.type ?? "Error"}: ${r.error.message}`); toast.error(`Invocation failed (${r.status_code})`); }
      else toast.success(`Invoked ${slug} → ${r.status_code} in ${r.duration_ms}ms`);
      await refresh();
    } catch (e) { setInvokeErr((e as Error).message); toast.error((e as Error).message); }
    finally { setInvoking(false); }
  }

  // Preview upcoming cron runs (client-side, mirrors backend nextRun MVP).
  function previewCron(expr: string, n = 3): string[] {
    const parts = expr.trim().split(/\s+/); if (parts.length !== 5) return [];
    const match = (v: number, f: string) => f === "*" || (f.startsWith("*/") ? v % Number(f.slice(2)) === 0 : f.split(",").some(s => Number(s) === v));
    const out: string[] = []; const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 60 * 24 * 7 && out.length < n; i++) {
      if (match(d.getMinutes(), parts[0]) && match(d.getHours(), parts[1]) && match(d.getDate(), parts[2]) &&
          match(d.getMonth() + 1, parts[3]) && match(d.getDay(), parts[4])) out.push(d.toLocaleString());
      d.setMinutes(d.getMinutes() + 1);
    }
    return out;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Edge Functions</h1>
          <p className="text-sm text-muted-foreground">Per-function secrets, cron schedules, and invocation logs.</p>
        </div>
        <div className="flex gap-2">
          <Input value={slug} onChange={e => setSlug(e.target.value)} className="w-40" placeholder="function-slug" />
          <Button variant="outline" size="sm" onClick={refresh}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
          <Button size="sm" onClick={invoke} disabled={invoking || !!jsonErr}>
            {invoking ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />} Invoke
          </Button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {(["functions","secrets","schedules","logs"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={"px-4 py-2 text-sm border-b-2 -mb-px " + (tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t}
          </button>
        ))}
      </div>

      {tab === "functions" && (
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Boxes className="h-4 w-4" /> Create / update function</CardTitle></CardHeader>
            <CardContent className="flex gap-2 flex-wrap items-center">
              <Input placeholder="slug (a-z, digits, -)" value={newSlug} onChange={e => setNewSlug(e.target.value.toLowerCase())} className="w-48" />
              <Input placeholder="display name" value={newName} onChange={e => setNewName(e.target.value)} className="w-56" />
              <select className="h-9 px-2 rounded-md border border-border bg-background text-sm" value={runtime} onChange={e => setRuntime(e.target.value as "node20"|"deno1"|"bun1")}>
                <option value="node20">node20</option><option value="deno1">deno1</option><option value="bun1">bun1</option>
              </select>
              <Button size="sm" onClick={createFn}><Plus className="h-4 w-4 mr-1" /> Save</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4" /> Test invoke {slug}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <textarea className={"w-full min-h-[80px] font-mono text-xs p-2 rounded-md border bg-background " + (jsonErr ? "border-destructive" : "border-border")}
                        value={invokePayload} onChange={e => setInvokePayload(e.target.value)} />
              {jsonErr && <div className="text-[11px] text-destructive">Invalid JSON: {jsonErr}</div>}
              <div className="flex justify-end"><Button size="sm" onClick={invoke} disabled={!!jsonErr || invoking}>
                {invoking ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />} Run
              </Button></div>
              {invokeErr && (
                <div className="p-2 rounded-md bg-destructive/10 border border-destructive/40 text-xs">
                  <div className="font-medium text-destructive">Invocation error</div>
                  <div className="font-mono mt-1">{invokeErr}</div>
                  {invokeResult?.error?.stack && <pre className="text-[10px] font-mono mt-1 text-muted-foreground whitespace-pre-wrap">{invokeResult.error.stack}</pre>}
                </div>
              )}
              {invokeResult && (
                <pre className="text-[10px] font-mono p-2 rounded-md bg-muted max-h-[200px] overflow-auto">{JSON.stringify(invokeResult, null, 2)}</pre>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Functions</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-1">
                {functions.map(f => (
                  <div key={f.id} className="grid grid-cols-[1fr,80px,80px,80px,80px,90px] gap-2 items-center text-xs p-2 border border-border rounded-md">
                    <div>
                      <button className="font-medium hover:underline" onClick={() => setSlug(f.slug)}>{f.slug}</button>
                      <span className="text-muted-foreground ml-2">{f.display_name}</span>
                    </div>
                    <Badge variant="secondary">{f.runtime}</Badge>
                    <span>{f.secrets} secrets</span>
                    <span>{f.schedules} cron</span>
                    <span>{f.invocations_24h}/24h</span>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" title="Delete function" onClick={async () => {
                        if (!confirm(`Delete function "${f.slug}"? This removes secrets, schedules, and invocation history.`)) return;
                        try { await edgeV2.deleteFunction(f.slug); toast.success("Function deleted"); refresh(); }
                        catch (e) { toast.error((e as Error).message); }
                      }}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
                {functions.length === 0 && <div className="text-xs text-muted-foreground">No functions registered yet.</div>}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "secrets" && (
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><KeyRound className="h-4 w-4" /> Secrets for {slug}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input placeholder="NAME (UPPER_SNAKE)" value={secName} onChange={e => setSecName(e.target.value.toUpperCase())} />
              <Input placeholder="value (masked)" type={showSecret ? "text" : "password"} autoComplete="off"
                     value={secVal} onChange={e => setSecVal(e.target.value)} />
              <Button size="sm" variant="outline" onClick={() => setShowSecret(v => !v)} title={showSecret ? "Hide" : "Reveal while typing"}>
                {showSecret ? "Hide" : "Show"}
              </Button>
              <Button size="sm" onClick={addSecret}><Plus className="h-4 w-4" /> Save</Button>
            </div>
            <div className="text-[11px] text-muted-foreground">Secret values are AES-256-GCM encrypted at rest and never returned by the API.</div>
            <div className="space-y-1">
              {secrets.map(s => (
                <div key={s.id} className="flex items-center justify-between p-2 border border-border rounded-md text-sm">
                  <div><span className="font-mono">{s.name}</span> <span className="text-muted-foreground text-xs">· {new Date(s.created_at).toLocaleString()}</span></div>
                  <Button size="sm" variant="ghost" title="Delete secret" onClick={async () => {
                    if (!confirm(`Delete secret "${s.name}"?`)) return;
                    try { await edgeV2.deleteSecret(s.id); toast.success("Secret deleted"); refresh(); }
                    catch (e) { toast.error((e as Error).message); }
                  }}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              {secrets.length === 0 && <div className="text-xs text-muted-foreground">No secrets configured.</div>}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "schedules" && (
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Clock className="h-4 w-4" /> Cron schedules</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input placeholder="* * * * *" value={cron} onChange={e => setCron(e.target.value)} />
              <Button size="sm" onClick={addSchedule}><Plus className="h-4 w-4" /> Add for {slug}</Button>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Preview next runs: {previewCron(cron).map((s, i) => <span key={i} className="mr-2 font-mono">{s}</span>)}
              {previewCron(cron).length === 0 && <span className="italic">invalid cron</span>}
            </div>
            <div className="space-y-1">
              {schedules.map(s => (
                <div key={s.id} className="flex items-center justify-between p-2 border border-border rounded-md text-sm">
                  <div>
                    <span className="font-medium">{s.function_slug}</span>
                    <span className="ml-2 font-mono text-xs">{s.cron}</span>
                    <Badge variant={s.active ? "default" : "secondary"} className="ml-2">{s.active ? "active" : "paused"}</Badge>
                    {s.next_run_at && <span className="ml-2 text-xs text-muted-foreground">next: {new Date(s.next_run_at).toLocaleString()}</span>}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={async () => { await edgeV2.toggleSchedule(s.id, !s.active); refresh(); }}>
                      {s.active ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    </Button>
                    <Button size="sm" variant="ghost" title="Delete schedule" onClick={async () => {
                      if (!confirm(`Delete cron "${s.cron}" for ${s.function_slug}?`)) return;
                      try { await edgeV2.deleteSchedule(s.id); toast.success("Schedule deleted"); refresh(); }
                      catch (e) { toast.error((e as Error).message); }
                    }}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
              {schedules.length === 0 && <div className="text-xs text-muted-foreground">No schedules.</div>}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "logs" && <InvocationsTable rows={invos} />}
    </div>
  );
}

function InvocationsTable({ rows }: { rows: FnInvocation[] }) {
  const t = usePaginatedTable(rows, { pageSize: 25, defaultSort: { key: "created_at", dir: "desc" } });
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><ScrollText className="h-4 w-4" /> Invocations</CardTitle></CardHeader>
      <CardContent>
        <PaginatedTable
          rows={t.rows} sorted={t.sorted}
          page={t.page} pageSize={t.pageSize} totalPages={t.totalPages}
          sortKey={t.sortKey} sortDir={t.sortDir}
          onPage={t.setPage} onSort={t.toggleSort}
          csvFilename="edge-invocations.csv"
          csvColumns={["created_at","function_slug","trigger","status_code","duration_ms","cold_start","error"]}
          columns={[
            { key: "status_code", label: "status", className: "w-16",
              render: (r) => <Badge variant={r.status_code && r.status_code >= 400 ? "destructive" : "secondary"}>{r.status_code ?? "-"}</Badge> },
            { key: "function_slug", label: "function" },
            { key: "trigger", label: "trigger", className: "w-20" },
            { key: "duration_ms", label: "ms", className: "w-16",
              render: (r) => <span>{r.duration_ms ?? "-"}</span> },
            { key: "error", label: "message" },
            { key: "created_at", label: "time", className: "w-40",
              render: (r) => <span className="text-muted-foreground text-right">{new Date(r.created_at).toLocaleString()}</span> },
          ]}
          empty="No invocations recorded."
        />
      </CardContent>
    </Card>
  );
}
