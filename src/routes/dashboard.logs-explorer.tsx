import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollText, Radio, Search, RefreshCw, Save, Download, FileJson, FileText, X, Filter } from "lucide-react";
import { toast } from "sonner";
import { isLive, logsV2, applyClientFilters, extractLogFields, type LogRow, type LogSearch } from "@/lib/pluto/live";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardLogsExplorerHelp } from "@/content/help/dashboard.logs-explorer";

const searchSchema = z.object({
  source: fallback(z.string(), "").default(""),
  level: fallback(z.string(), "").default(""),
  q: fallback(z.string(), "").default(""),
  environment: fallback(z.string(), "").default(""),
  resource: fallback(z.string(), "").default(""),
  route: fallback(z.string(), "").default(""),
  request_path: fallback(z.string(), "").default(""),
  status_code: fallback(z.string(), "").default(""),
  request_type: fallback(z.string(), "").default(""),
  host: fallback(z.string(), "").default(""),
  service: fallback(z.string(), "").default(""),
  request_method: fallback(z.string(), "").default(""),
  cache: fallback(z.string(), "").default(""),
  branch: fallback(z.string(), "").default(""),
  workflow_run: fallback(z.string(), "").default(""),
  workflow_step: fallback(z.string(), "").default(""),
  deployment_id: fallback(z.string(), "").default(""),
  slug: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/dashboard/logs-explorer")({
  validateSearch: zodValidator(searchSchema),
  component: LogsExplorer,
});

const LEVELS = ["", "info", "warn", "error", "debug"];
const REQUEST_METHODS = ["", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const REQUEST_TYPES = ["", "html", "api", "asset", "webhook", "sse"];
const ENVIRONMENTS = ["", "production", "preview", "sandbox", "development"];
const SERVICES = ["", "worker", "nginx", "edge", "auth", "rest", "storage", "admin"];
const CACHES = ["", "HIT", "MISS", "BYPASS", "EXPIRED", "STALE"];
const STATUS_CODES = ["", "2xx", "3xx", "4xx", "5xx", "200", "301", "304", "400", "401", "403", "404", "409", "429", "500", "502", "503", "504"];

const FILTER_KEYS = [
  "environment", "resource", "route", "request_path", "status_code", "request_type",
  "host", "service", "request_method", "cache", "branch", "workflow_run",
  "workflow_step", "deployment_id", "slug",
] as const;

const levelClass: Record<string, string> = {
  info: "bg-sky-500/15 text-sky-600",
  warn: "bg-amber-500/15 text-amber-600",
  error: "bg-destructive/15 text-destructive",
  debug: "bg-muted text-muted-foreground",
};

const statusClass = (code: number | null | undefined): string => {
  if (code == null) return "bg-muted text-muted-foreground";
  if (code >= 500) return "bg-destructive/15 text-destructive";
  if (code >= 400) return "bg-amber-500/15 text-amber-600";
  if (code >= 300) return "bg-sky-500/15 text-sky-600";
  return "bg-emerald-500/15 text-emerald-600";
};

type TailStatus = "idle" | "connecting" | "live" | "retrying" | "failed";
type ExportJob = {
  id: string; status: "queued" | "running" | "done" | "error";
  progress: number; rows: number; format: "csv" | "json";
  clamped: boolean; keepDays: number; error?: string | null;
};

function LogsExplorer() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [rows, setRows] = useState<LogRow[]>([]);
  const [tailOn, setTailOn] = useState(false);
  const [tailStatus, setTailStatus] = useState<TailStatus>("idle");
  const [tailAttempt, setTailAttempt] = useState(0);
  const [keepDays, setKeepDays] = useState<string>("30");
  const [savingRetention, setSavingRetention] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [rangeHours, setRangeHours] = useState<string>("24");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const stopRef = useRef<null | (() => void)>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setField = useCallback(
    (k: keyof z.infer<typeof searchSchema>, v: string) => {
      void navigate({ to: ".", search: (prev: z.infer<typeof searchSchema>) => ({ ...prev, [k]: v }) });
    },
    [navigate],
  );
  const clearAll = useCallback(() => {
    void navigate({
      search: () => ({
        source: "", level: "", q: "", environment: "", resource: "", route: "",
        request_path: "", status_code: "", request_type: "", host: "", service: "",
        request_method: "", cache: "", branch: "", workflow_run: "", workflow_step: "",
        deployment_id: "", slug: "",
      }),
    });
  }, [navigate]);

  const activeChips = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const k of ["source", "level", "q", ...FILTER_KEYS] as const) {
      const v = search[k as keyof typeof search];
      if (v) entries.push([k, String(v)]);
    }
    return entries;
  }, [search]);

  const runSearch = useCallback(async () => {
    if (!isLive()) return;
    setErr(null);
    try {
      // Send everything to backend; unknown params are ignored server-side.
      const params: LogSearch = {};
      for (const k of ["source", "level", "q", ...FILTER_KEYS] as const) {
        const v = search[k as keyof typeof search];
        if (v) (params as Record<string, string>)[k] = String(v);
      }
      params.q ||= search.q;
      params.limit = 500;
      const r = await logsV2.search(params);
      // Belt-and-braces client filter for anything the backend didn't apply.
      const filtered = applyClientFilters(r.logs, {
        environment: search.environment, resource: search.resource, route: search.route,
        request_path: search.request_path, status_code: search.status_code,
        request_type: search.request_type, host: search.host, service: search.service,
        request_method: search.request_method, cache: search.cache, branch: search.branch,
        workflow_run: search.workflow_run, workflow_step: search.workflow_step,
        deployment_id: search.deployment_id, slug: search.slug,
        contains: search.q,
      });
      setRows(filtered);
    } catch (e) { setErr((e as Error).message); }
  }, [search]);

  useEffect(() => { void runSearch(); }, [runSearch]);
  useEffect(() => {
    if (!isLive()) return;
    logsV2.retention().then((r) => setKeepDays(String(r.keep_days))).catch(() => undefined);
  }, []);

  useEffect(() => {
    stopRef.current?.(); stopRef.current = null;
    if (!tailOn || !isLive()) { setTailStatus("idle"); setTailAttempt(0); return; }
    setTailStatus("connecting"); setTailAttempt(0);
    const stop = logsV2.tail(
      { source: search.source || undefined, level: search.level || undefined, q: search.q || undefined },
      {
        onRow: (r) => {
          const enriched = extractLogFields(r);
          // Filter incoming tail rows by extended dimensions locally.
          const kept = applyClientFilters([enriched], {
            environment: search.environment, resource: search.resource, route: search.route,
            request_path: search.request_path, status_code: search.status_code,
            request_type: search.request_type, host: search.host, service: search.service,
            request_method: search.request_method, cache: search.cache, branch: search.branch,
            workflow_run: search.workflow_run, workflow_step: search.workflow_step,
            deployment_id: search.deployment_id, slug: search.slug,
            contains: search.q,
          });
          if (kept.length) setRows((prev) => [kept[0], ...prev].slice(0, 500));
        },
        onStatus: (s, a) => { setTailStatus(s); if (typeof a === "number") setTailAttempt(a); },
        onError: (e) => setErr(e.message),
      },
    );
    stopRef.current = stop;
    return () => { stop(); stopRef.current = null; };
  }, [tailOn, search]);

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
        format, source: search.source || undefined, level: search.level || undefined,
        q: search.q || undefined, since, until,
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
    idle: "text-muted-foreground", connecting: "text-amber-500",
    live: "text-emerald-500", retrying: "text-amber-500", failed: "text-destructive",
  };

  const Select = ({ value, onChange, options, placeholder }: {
    value: string; onChange: (v: string) => void; options: readonly string[]; placeholder: string;
  }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="h-9 px-2 rounded-md border border-border bg-background text-sm">
      {options.map((o) => <option key={o} value={o}>{o || placeholder}</option>)}
    </select>
  );
  const TextIn = ({ k, ph }: { k: keyof z.infer<typeof searchSchema>; ph: string }) => (
    <Input placeholder={ph} value={String(search[k] ?? "")} onChange={(e) => setField(k, e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }} className="h-9 w-40" />
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ScrollText className="h-5 w-5" /> Logs Explorer
          </h1>
          <HelpPanel help={dashboardLogsExplorerHelp} />
          <p className="text-sm text-muted-foreground">
            Filter by any dimension — console level, environment, route, status code, deployment, workflow step, and more. Fields are extracted from structured JSON log lines when present.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs inline-flex items-center gap-1">
            <input type="checkbox" checked={tailOn} onChange={(e) => setTailOn(e.target.checked)} />
            <Radio className={"h-3 w-3 " + statusColor[tailStatus]} /> Live tail
          </label>
          {tailOn && (
            <span className={"text-[10px] font-mono " + statusColor[tailStatus]}>
              {tailStatus}{tailStatus === "retrying" && ` #${tailAttempt}`}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={() => void runSearch()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      {!isLive() && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
          Set <code>VITE_PLUTO_URL</code> to a running Pluto instance to explore logs.
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Search className="h-4 w-4" /> Filters
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAdvanced((s) => !s)}>
                <Filter className="h-3 w-3 mr-1" /> {showAdvanced ? "Hide" : "Show"} advanced
              </Button>
              {activeChips.length > 0 && (
                <Button size="sm" variant="ghost" onClick={clearAll}>
                  <X className="h-3 w-3 mr-1" /> Clear all
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Primary filters */}
          <div className="flex flex-wrap gap-2 items-center">
            <Input placeholder="Contains… (message / path / route)" value={search.q}
              onChange={(e) => setField("q", e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
              className="h-9 w-64" />
            <Select value={search.level} onChange={(v) => setField("level", v)} options={LEVELS} placeholder="any level" />
            <Select value={search.environment} onChange={(v) => setField("environment", v)} options={ENVIRONMENTS} placeholder="any environment" />
            <Select value={search.status_code} onChange={(v) => setField("status_code", v)} options={STATUS_CODES} placeholder="any status" />
            <Select value={search.request_method} onChange={(v) => setField("request_method", v)} options={REQUEST_METHODS} placeholder="any method" />
            <Select value={search.request_type} onChange={(v) => setField("request_type", v)} options={REQUEST_TYPES} placeholder="any type" />
            <Select value={search.service} onChange={(v) => setField("service", v)} options={SERVICES} placeholder="any service" />
            <Select value={search.cache} onChange={(v) => setField("cache", v)} options={CACHES} placeholder="any cache" />
            <div className="ml-auto flex items-center gap-2">
              <label className="text-[11px] text-muted-foreground">Retention</label>
              <Input type="number" min={1} max={365} value={keepDays}
                onChange={(e) => setKeepDays(e.target.value)} className="w-20" />
              <Button size="sm" variant="outline" onClick={saveRetention} disabled={savingRetention}>
                <Save className="h-3 w-3 mr-1" /> Save
              </Button>
            </div>
          </div>

          {/* Advanced filters */}
          {showAdvanced && (
            <div className="flex flex-wrap gap-2 items-center border-t border-border pt-3">
              <TextIn k="route" ph="Route (/api/x/$id)" />
              <TextIn k="request_path" ph="Request path" />
              <TextIn k="host" ph="Host" />
              <TextIn k="resource" ph="Resource" />
              <TextIn k="deployment_id" ph="Deployment ID" />
              <TextIn k="slug" ph="Slug" />
              <TextIn k="branch" ph="Branch" />
              <TextIn k="workflow_run" ph="Workflow Run" />
              <TextIn k="workflow_step" ph="Workflow Step" />
              <TextIn k="source" ph="Source" />
            </div>
          )}

          {/* Active filter chips */}
          {activeChips.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-2">
              {activeChips.map(([k, v]) => (
                <Badge key={k} variant="secondary" className="gap-1">
                  <span className="text-[10px] text-muted-foreground">{k}:</span>
                  <span className="text-[11px]">{v}</span>
                  <button onClick={() => setField(k as keyof z.infer<typeof searchSchema>, "")}
                    className="ml-1 hover:text-destructive" aria-label={`Clear ${k}`}>
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2">
          <Download className="h-4 w-4" /> Export filtered logs
        </CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 items-center text-xs">
            <label className="text-muted-foreground">Range (hours back)</label>
            <Input type="number" min={1} max={24 * 365} value={rangeHours}
              onChange={(e) => setRangeHours(e.target.value)} className="w-24" />
            <span className="text-muted-foreground">
              (retention: {keepDays}d — older data is pruned and clamped automatically)
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
        <CardHeader>
          <CardTitle className="text-sm">
            {rows.length} entries{tailOn && ` (${tailStatus})`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 max-h-[640px] overflow-y-auto font-mono">
            {rows.map((r) => {
              const isOpen = expanded === r.id;
              return (
                <div key={r.id}
                  className="border border-border rounded-md hover:border-primary/40 transition-colors">
                  <button
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    className="w-full text-left grid grid-cols-[150px,60px,54px,60px,1fr] gap-2 items-center text-[11px] p-2"
                  >
                    <span className="text-muted-foreground">{new Date(r.ts).toLocaleString()}</span>
                    <Badge variant="secondary" className="justify-self-start">{r.source}</Badge>
                    <span className={"px-1.5 py-0.5 rounded text-[10px] text-center " + (levelClass[r.level] ?? "bg-muted")}>
                      {r.level}
                    </span>
                    {r.status_code != null ? (
                      <span className={"px-1.5 py-0.5 rounded text-[10px] text-center font-semibold " + statusClass(r.status_code)}>
                        {r.status_code}
                      </span>
                    ) : <span />}
                    <span className="truncate">
                      {r.request_method && <span className="text-primary font-semibold mr-1">{r.request_method}</span>}
                      {r.request_path ?? r.route ?? r.message}
                      {r.duration_ms != null && (
                        <span className="text-muted-foreground ml-2">· {r.duration_ms}ms</span>
                      )}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border p-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                      {[
                        ["environment", r.environment], ["host", r.host], ["service", r.service],
                        ["resource", r.resource], ["route", r.route], ["request_path", r.request_path],
                        ["request_method", r.request_method], ["request_type", r.request_type],
                        ["status_code", r.status_code], ["cache", r.cache], ["duration_ms", r.duration_ms],
                        ["deployment_id", r.deployment_id], ["slug", r.slug], ["branch", r.branch],
                        ["workflow_run", r.workflow_run], ["workflow_step", r.workflow_step],
                        ["user_id", r.user_id],
                      ].filter(([, v]) => v != null && v !== "").map(([k, v]) => (
                        <div key={String(k)} className="flex gap-2">
                          <span className="text-muted-foreground">{k}:</span>
                          <button
                            className="hover:text-primary truncate"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (FILTER_KEYS.includes(k as typeof FILTER_KEYS[number])) {
                                setField(k as keyof z.infer<typeof searchSchema>, String(v));
                              }
                            }}
                            title="Click to filter by this value"
                          >{String(v)}</button>
                        </div>
                      ))}
                      <div className="col-span-2 mt-1 pt-1 border-t border-border/50">
                        <span className="text-muted-foreground">message:</span>
                        <pre className="mt-1 whitespace-pre-wrap break-all">{r.message}</pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {rows.length === 0 && <div className="text-xs text-muted-foreground p-4 text-center">No matching logs.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
