import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollText, Radio, Search, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { isLive, logsV2, type LogRow } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/logs-explorer")({ component: LogsExplorer });

const SOURCES = ["", "auth", "rest", "storage", "admin"] as const;
const LEVELS  = ["", "info", "warn", "error"] as const;
const levelClass: Record<string, string> = {
  info: "bg-sky-500/15 text-sky-600",
  warn: "bg-amber-500/15 text-amber-600",
  error: "bg-destructive/15 text-destructive",
};

function LogsExplorer() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [source, setSource] = useState<string>("");
  const [level, setLevel] = useState<string>("");
  const [q, setQ] = useState<string>("");
  const [tailOn, setTailOn] = useState(false);
  const [keepDays, setKeepDays] = useState<string>("30");
  const [savingRetention, setSavingRetention] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stopRef = useRef<null | (() => void)>(null);

  const search = useCallback(async () => {
    if (!isLive()) return;
    setErr(null);
    try {
      const r = await logsV2.search({ source: source || undefined, level: level || undefined, q: q || undefined, limit: 300 });
      setRows(r.logs);
    } catch (e) { setErr((e as Error).message); }
  }, [source, level, q]);

  useEffect(() => { void search(); }, [search]);
  useEffect(() => {
    if (!isLive()) return;
    logsV2.retention().then(r => setKeepDays(String(r.keep_days))).catch(() => undefined);
  }, []);

  useEffect(() => {
    stopRef.current?.(); stopRef.current = null;
    if (!tailOn || !isLive()) return;
    const stop = logsV2.tail(
      { source: source || undefined, level: level || undefined, q: q || undefined },
      { onRow: (r) => setRows(prev => [r, ...prev].slice(0, 500)),
        onError: (e) => { setErr(e.message); setTailOn(false); } },
    );
    stopRef.current = stop;
    return () => { stop(); stopRef.current = null; };
  }, [tailOn, source, level, q]);

  useEffect(() => () => { stopRef.current?.(); }, []);

  async function saveRetention() {
    const n = Number(keepDays);
    if (!Number.isFinite(n) || n < 1 || n > 365) { toast.error("keep_days must be 1..365"); return; }
    setSavingRetention(true);
    try { await logsV2.setRetention(n); toast.success(`Retention set to ${n} days`); }
    catch (e) { toast.error((e as Error).message); }
    finally { setSavingRetention(false); }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><ScrollText className="h-5 w-5" /> Logs Explorer</h1>
          <p className="text-sm text-muted-foreground">Search structured request logs, tail live traffic, and manage retention.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs inline-flex items-center gap-1">
            <input type="checkbox" checked={tailOn} onChange={e => setTailOn(e.target.checked)} />
            <Radio className={"h-3 w-3 " + (tailOn ? "text-emerald-500" : "text-muted-foreground")} />
            Live tail
          </label>
          <Button size="sm" variant="outline" onClick={() => void search()}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
        </div>
      </div>

      {!isLive() && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
          Set <code>VITE_PLUTO_URL</code> to a running Pluto instance to explore logs.
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Search className="h-4 w-4" /> Filters</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2 items-center">
          <select value={source} onChange={e => setSource(e.target.value)} className="h-9 px-2 rounded-md border border-border bg-background text-sm">
            {SOURCES.map(s => <option key={s} value={s}>{s || "any source"}</option>)}
          </select>
          <select value={level} onChange={e => setLevel(e.target.value)} className="h-9 px-2 rounded-md border border-border bg-background text-sm">
            {LEVELS.map(l => <option key={l} value={l}>{l || "any level"}</option>)}
          </select>
          <Input placeholder="message contains…" value={q} onChange={e => setQ(e.target.value)}
                 onKeyDown={e => { if (e.key === "Enter") void search(); }} className="max-w-xs" />
          <div className="ml-auto flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground">Retention</label>
            <Input type="number" min={1} max={365} value={keepDays} onChange={e => setKeepDays(e.target.value)} className="w-20" />
            <Button size="sm" variant="outline" onClick={saveRetention} disabled={savingRetention}>
              <Save className="h-3 w-3 mr-1" /> Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {err && <div className="text-xs text-destructive">{err}</div>}

      <Card>
        <CardHeader><CardTitle className="text-sm">{rows.length} entries{tailOn && " (tailing)"}</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1 max-h-[560px] overflow-y-auto font-mono">
            {rows.map(r => (
              <div key={r.id} className="grid grid-cols-[160px,60px,80px,1fr] gap-2 text-[11px] p-2 border border-border rounded-md">
                <span className="text-muted-foreground">{new Date(r.ts).toLocaleString()}</span>
                <Badge variant="secondary">{r.source}</Badge>
                <span className={"px-1.5 py-0.5 rounded text-[10px] " + (levelClass[r.level] ?? "bg-muted")}>{r.level}</span>
                <span className="truncate">{r.message}</span>
              </div>
            ))}
            {rows.length === 0 && <div className="text-xs text-muted-foreground">No matching logs.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
