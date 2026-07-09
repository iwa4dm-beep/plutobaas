import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollText, Radio, Search, RefreshCw, Save, Download, FileJson, FileText } from "lucide-react";
import { toast } from "sonner";
import { isLive, logsV2, type LogRow } from "@/lib/pluto/live";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/logs-explorer")({ component: LogsExplorer });

const SOURCES = ["", "auth", "rest", "storage", "admin"] as const;
const LEVELS  = ["", "info", "warn", "error"] as const;
const levelClass: Record<string, string> = {
  info: "bg-sky-500/15 text-sky-600",
  warn: "bg-amber-500/15 text-amber-600",
  error: "bg-destructive/15 text-destructive",
};

type TailStatus = "idle" | "connecting" | "live" | "retrying" | "failed";
type ExportJob = {
  id: string; status: "queued" | "running" | "done" | "error";
  progress: number; rows: number; format: "csv" | "json";
  clamped: boolean; keepDays: number; error?: string | null;
};

function LogsExplorer() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [source, setSource] = useState<string>("");
  const [level, setLevel] = useState<string>("");
  const [q, setQ] = useState<string>("");
  const [tailOn, setTailOn] = useState(false);
  const [tailStatus, setTailStatus] = useState<TailStatus>("idle");
  const [tailAttempt, setTailAttempt] = useState(0);
  const [keepDays, setKeepDays] = useState<string>("30");
  const [savingRetention, setSavingRetention] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [rangeHours, setRangeHours] = useState<string>("24");
  const stopRef = useRef<null | (() => void)>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    if (!tailOn || !isLive()) { setTailStatus("idle"); setTailAttempt(0); return; }
    setTailStatus("connecting"); setTailAttempt(0);
    const stop = logsV2.tail(
      { source: source || undefined, level: level || undefined, q: q || undefined },
      {
        onRow: (r) => setRows(prev => [r, ...prev].slice(0, 500)),
        onStatus: (s, attempt) => { setTailStatus(s); if (typeof attempt === "number") setTailAttempt(attempt); },
        onError: (e) => { setErr(e.message); },
      },
    );
    stopRef.current = stop;
    return () => { stop(); stopRef.current = null; };
  }, [tailOn, source, level, q]);

  useEffect(() => () => { stopRef.current?.(); if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function saveRetention() {
    const n = Number(keepDays);
    if (!Number.isFinite(n) || n < 1 || n > 365) { toast.error("keep_days must be 1..365"); return; }
    setSavingRetention(true);
    try { await logsV2.setRetention(n); toast.success(`Retention set to ${n} days`); }
    catch (e) { toast.error((e as Error).message); }
    finally { setSavingRetention(false); }
  }

  async function startExport(format: "csv" | "json") {
    if (!isLive()) return;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    const hours = Math.max(1, Math.min(24 * 365, Number(rangeHours) || 24));
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const until = new Date().toISOString();
    try {
      const j = await logsV2.startExport({
        format, source: source || undefined, level: level || undefined, q: q || undefined,
        since, until,
      });
      setExportJob({
        id: j.job_id, status: j.status as ExportJob["status"], progress: j.progress, rows: 0,
        format, clamped: j.clamped_since, keepDays: j.keep_days, error: null,
      });
      if (j.clamped_since) toast.info(`Range clamped to ${j.keep_days}-day retention window`);
      pollRef.current = setInterval(async () => {
        try {
          const p = await logsV2.getExport(j.job_id);
          setExportJob({
            id: p.job_id, status: p.status, progress: p.progress, rows: p.rows,
            format: p.format, clamped: j.clamped_since, keepDays: j.keep_days, error: p.error,
          });
          if (p.status === "done" || p.status === "error") {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          }
        } catch (e) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setErr((e as Error).message);
        }
      }, 800);
    } catch (e) { toast.error((e as Error).message); }
  }

  async function downloadJob(job: ExportJob) {
    try {
      const blob = await logsV2.downloadExport(job.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `logs-${job.id}.${job.format}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error((e as Error).message); }
  }

  const statusColor: Record<TailStatus, string> = {
    idle: "text-muted-foreground",
    connecting: "text-amber-500",
    live: "text-emerald-500",
    retrying: "text-amber-500",
    failed: "text-destructive",
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><ScrollText className="h-5 w-5" /> Logs Explorer</h1>
      <AutoHelpPanel slug={'dashboard.logs-explorer'} title={'Logs Explorer'} description={''} />
          <p className="text-sm text-muted-foreground">Search structured request logs, tail live traffic with automatic resume, and export filtered slices.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs inline-flex items-center gap-1">
            <input type="checkbox" checked={tailOn} onChange={e => setTailOn(e.target.checked)} />
            <Radio className={"h-3 w-3 " + statusColor[tailStatus]} />
            Live tail
          </label>
          {tailOn && (
            <span className={"text-[10px] font-mono " + statusColor[tailStatus]}>
              {tailStatus}{tailStatus === "retrying" && ` #${tailAttempt}`}
            </span>
          )}
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

      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Download className="h-4 w-4" /> Export filtered logs</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 items-center text-xs">
            <label className="text-muted-foreground">Range (hours back)</label>
            <Input type="number" min={1} max={24 * 365} value={rangeHours}
                   onChange={e => setRangeHours(e.target.value)} className="w-24" />
            <span className="text-muted-foreground">
              (retention: {keepDays}d — older data is pruned and will be clamped automatically)
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => startExport("csv")}
                      disabled={exportJob?.status === "queued" || exportJob?.status === "running"}>
                <FileText className="h-3 w-3 mr-1" /> Export CSV
              </Button>
              <Button size="sm" variant="outline" onClick={() => startExport("json")}
                      disabled={exportJob?.status === "queued" || exportJob?.status === "running"}>
                <FileJson className="h-3 w-3 mr-1" /> Export JSON
              </Button>
            </div>
          </div>

          {exportJob && (
            <div className="border border-border rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant={
                    exportJob.status === "done" ? "default" :
                    exportJob.status === "error" ? "destructive" : "secondary"
                  }>{exportJob.status}</Badge>
                  <span className="font-mono">{exportJob.id}</span>
                  <span className="text-muted-foreground">· {exportJob.format.toUpperCase()} · {exportJob.rows} rows</span>
                  {exportJob.clamped && (
                    <span className="text-amber-500">· clamped to {exportJob.keepDays}d retention</span>
                  )}
                </div>
                {exportJob.status === "done" && (
                  <Button size="sm" onClick={() => downloadJob(exportJob)}>
                    <Download className="h-3 w-3 mr-1" /> Download
                  </Button>
                )}
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all"
                     style={{ width: `${Math.round(exportJob.progress * 100)}%` }} />
              </div>
              {exportJob.error && <div className="text-[11px] text-destructive">{exportJob.error}</div>}
            </div>
          )}
        </CardContent>
      </Card>

      {err && <div className="text-xs text-destructive">{err}</div>}

      <Card>
        <CardHeader><CardTitle className="text-sm">{rows.length} entries{tailOn && ` (${tailStatus})`}</CardTitle></CardHeader>
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
