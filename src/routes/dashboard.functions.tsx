import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { edgeV2, isLive, type FnSecret, type FnSchedule, type FnInvocation } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Clock, ScrollText, Plus, RefreshCw, Trash2, Play, Pause } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/functions")({ component: FunctionsPage });

function FunctionsPage() {
  const [tab, setTab] = useState<"secrets"|"schedules"|"logs">("secrets");
  const [slug, setSlug] = useState("hello");
  const [secrets, setSecrets] = useState<FnSecret[]>([]);
  const [schedules, setSchedules] = useState<FnSchedule[]>([]);
  const [invos, setInvos] = useState<FnInvocation[]>([]);
  const [secName, setSecName] = useState(""); const [secVal, setSecVal] = useState("");
  const [cron, setCron] = useState("*/5 * * * *");

  async function refresh() {
    if (!isLive()) return;
    try {
      const [s, sc, iv] = await Promise.all([edgeV2.secrets(slug), edgeV2.schedules(), edgeV2.invocations(slug, 100)]);
      setSecrets(s.secrets); setSchedules(sc.schedules); setInvos(iv.invocations);
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
  async function fakeInvoke() {
    const start = Date.now();
    await new Promise(r => setTimeout(r, 40 + Math.random()*100));
    await edgeV2.logInvocation({ function_slug: slug, trigger: "manual", status_code: 200, duration_ms: Date.now()-start });
    toast.success("Invocation recorded"); refresh();
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
          <Button size="sm" onClick={fakeInvoke}><Play className="h-4 w-4 mr-1" /> Test invoke</Button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {(["secrets","schedules","logs"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={"px-4 py-2 text-sm border-b-2 -mb-px " + (tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t}
          </button>
        ))}
      </div>

      {tab === "secrets" && (
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><KeyRound className="h-4 w-4" /> Secrets for {slug}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input placeholder="NAME (UPPER_SNAKE)" value={secName} onChange={e => setSecName(e.target.value.toUpperCase())} />
              <Input placeholder="value" type="password" value={secVal} onChange={e => setSecVal(e.target.value)} />
              <Button size="sm" onClick={addSecret}><Plus className="h-4 w-4" /> Save</Button>
            </div>
            <div className="space-y-1">
              {secrets.map(s => (
                <div key={s.id} className="flex items-center justify-between p-2 border border-border rounded-md text-sm">
                  <div><span className="font-mono">{s.name}</span> <span className="text-muted-foreground text-xs">· {new Date(s.created_at).toLocaleString()}</span></div>
                  <Button size="sm" variant="ghost" onClick={async () => { await edgeV2.deleteSecret(s.id); refresh(); }}>
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
                    <Button size="sm" variant="ghost" onClick={async () => { await edgeV2.deleteSchedule(s.id); refresh(); }}>
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

      {tab === "logs" && (
        <Card>
          <CardHeader><CardTitle className="text-sm flex items-center gap-2"><ScrollText className="h-4 w-4" /> Invocations</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-[500px] overflow-y-auto">
              {invos.map(i => (
                <div key={i.id} className="grid grid-cols-[80px,80px,80px,1fr,120px] gap-2 text-xs p-2 border border-border rounded-md">
                  <Badge variant={i.status_code && i.status_code >= 400 ? "destructive" : "secondary"}>{i.status_code ?? "-"}</Badge>
                  <span>{i.trigger}</span>
                  <span>{i.duration_ms ?? "-"}ms</span>
                  <span className="truncate text-muted-foreground">{i.error ?? i.function_slug}</span>
                  <span className="text-muted-foreground text-right">{new Date(i.created_at).toLocaleTimeString()}</span>
                </div>
              ))}
              {invos.length === 0 && <div className="text-xs text-muted-foreground">No invocations recorded.</div>}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
