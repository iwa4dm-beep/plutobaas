import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, Download, Copy, ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  adminTraces,
  isLive,
  type AdminTraceEvent,
  type AdminTraceFilters,
} from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/traces")({
  head: () => ({
    meta: [
      { title: "Trace viewer — support triage" },
      { name: "description", content: "Look up captured error traces by traceId with pagination and filters." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TracesPage,
});

const STATUS_PRESETS: Array<{ label: string; filters: Partial<AdminTraceFilters> }> = [
  { label: "All",              filters: {} },
  { label: "5xx (server)",     filters: { minStatus: 500, maxStatus: 599 } },
  { label: "4xx (client)",     filters: { minStatus: 400, maxStatus: 499 } },
  { label: "Validation",       filters: { errorCode: "validation_failed" } },
  { label: "Auth (401)",       filters: { status: 401 } },
  { label: "Not found (404)",  filters: { status: 404 } },
];

function statusTone(status: number): string {
  if (status >= 500) return "bg-rose-500/10 text-rose-600 border-rose-500/30";
  if (status === 429) return "bg-amber-500/10 text-amber-600 border-amber-500/30";
  if (status >= 400) return "bg-amber-500/10 text-amber-700 border-amber-500/30";
  return "bg-emerald-500/10 text-emerald-600 border-emerald-500/30";
}

function TracesPage() {
  const [lookupId, setLookupId] = useState("");
  const [selected, setSelected] = useState<AdminTraceEvent | null>(null);
  const [source, setSource] = useState<"memory" | "database" | null>(null);

  const [filters, setFilters] = useState<AdminTraceFilters>({ limit: 50 });
  const [events, setEvents] = useState<AdminTraceEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadFirstPage = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured."); return; }
    setLoading(true); setErr(null);
    try {
      const r = await adminTraces.list(filters);
      setEvents(r.events);
      setCursor(r.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void loadFirstPage(); }, [loadFirstPage]);

  const loadNextPage = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true); setErr(null);
    try {
      const r = await adminTraces.list({ ...filters, cursor });
      setEvents((prev) => [...prev, ...r.events]);
      setCursor(r.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filters, cursor, loading]);

  const lookupById = useCallback(async () => {
    const id = lookupId.trim();
    if (!id) return;
    setLoading(true); setErr(null); setSelected(null); setSource(null);
    try {
      const r = await adminTraces.get(id);
      setSelected(r.event);
      setSource(r.source);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [lookupId]);

  const applyPreset = (preset: Partial<AdminTraceFilters>) => {
    setFilters({ limit: 50, ...preset });
  };

  const copy = async (text: string, label = "Copied") => {
    try { await navigator.clipboard.writeText(text); toast.success(label); }
    catch { toast.error("Copy failed"); }
  };

  const exportJson = () => {
    const rows = selected ? [selected] : events;
    if (!rows.length) { toast.error("Nothing to export"); return; }
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    downloadBlob(blob, `traces-${Date.now()}.json`);
  };

  const exportCsv = () => {
    if (!events.length) { toast.error("Nothing to export"); return; }
    const cols = ["at","traceId","status","error","code","tag","method","endpoint","url","message","actorId","ip"];
    const escape = (v: unknown) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const header = cols.join(",");
    const body = events.map((e) => cols.map((c) => escape((e as any)[c])).join(",")).join("\n");
    downloadBlob(new Blob([header + "\n" + body], { type: "text/csv" }), `traces-${Date.now()}.csv`);
  };

  const activeFilterCount = useMemo(
    () => Object.entries(filters).filter(([k, v]) => k !== "limit" && v !== undefined && v !== "").length,
    [filters],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trace viewer"
        description="Look up captured 4xx/5xx errors by traceId. Backed by the in-memory buffer with durable fallback to admin.error_events (30-day retention)."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!events.length}>
              <Download className="h-4 w-4 mr-1.5" /> CSV
            </Button>
            <Button variant="outline" size="sm" onClick={exportJson} disabled={!events.length && !selected}>
              <Download className="h-4 w-4 mr-1.5" /> JSON
            </Button>
            <Button size="sm" onClick={() => void loadFirstPage()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
              Refresh
            </Button>
          </div>
        }
      />

      {err && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-600">
          {err}
        </div>
      )}

      {/* Lookup by traceId */}
      <Card>
        <CardHeader><CardTitle className="text-base">Look up by Trace ID</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form
            onSubmit={(e) => { e.preventDefault(); void lookupById(); }}
            className="flex gap-2"
          >
            <Input
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              placeholder="e.g. cli_abc123 or trace-42"
              className="font-mono"
            />
            <Button type="submit" disabled={loading || !lookupId.trim()}>
              <Search className="h-4 w-4 mr-1.5" /> Lookup
            </Button>
          </form>
          {selected && (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={statusTone(selected.status)}>
                    {selected.status} {selected.error}
                  </Badge>
                  {selected.code && <Badge variant="secondary">{selected.code}</Badge>}
                  <Badge variant="outline">{selected.tag}</Badge>
                  {source && <Badge variant="outline" className="text-xs">{source}</Badge>}
                </div>
                <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setSource(null); }}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <TraceDetail evt={selected} onCopy={copy} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Filters {activeFilterCount > 0 && <Badge variant="secondary" className="ml-2">{activeFilterCount}</Badge>}</span>
            {activeFilterCount > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setFilters({ limit: 50 })}>Clear</Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {STATUS_PRESETS.map((p) => (
              <Button key={p.label} size="sm" variant="outline" onClick={() => applyPreset(p.filters)}>
                {p.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <LabeledInput label="Endpoint" value={filters.endpoint ?? ""} placeholder="/admin/v1/tokens"
              onChange={(v) => setFilters((f) => ({ ...f, endpoint: v || undefined }))} />
            <LabeledInput label="Error code" value={filters.errorCode ?? ""} placeholder="validation_failed"
              onChange={(v) => setFilters((f) => ({ ...f, errorCode: v || undefined }))} />
            <LabeledInput label="Status" value={filters.status ? String(filters.status) : ""} placeholder="500"
              onChange={(v) => setFilters((f) => ({ ...f, status: v ? Number(v) : undefined }))} />
            <LabeledInput label="Method" value={filters.method ?? ""} placeholder="POST"
              onChange={(v) => setFilters((f) => ({ ...f, method: (v.toUpperCase() as AdminTraceFilters["method"]) || undefined }))} />
            <LabeledInput label="From (ISO)" value={filters.from ?? ""} placeholder="2026-07-25T00:00:00Z"
              onChange={(v) => setFilters((f) => ({ ...f, from: v || undefined }))} />
            <LabeledInput label="To (ISO)" value={filters.to ?? ""} placeholder="2026-07-25T23:59:59Z"
              onChange={(v) => setFilters((f) => ({ ...f, to: v || undefined }))} />
            <LabeledInput label="Actor ID (uuid)" value={filters.actorId ?? ""} placeholder="uuid"
              onChange={(v) => setFilters((f) => ({ ...f, actorId: v || undefined }))} />
            <LabeledInput label="Limit" value={String(filters.limit ?? 50)} placeholder="50"
              onChange={(v) => setFilters((f) => ({ ...f, limit: v ? Math.max(1, Math.min(200, Number(v))) : 50 }))} />
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Results{" "}
            <span className="text-sm font-normal text-muted-foreground">
              ({events.length}{cursor ? "+" : ""})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!events.length && !loading && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No captured traces match these filters.
            </div>
          )}
          <ul className="divide-y divide-border">
            {events.map((e) => (
              <TraceRow key={e.traceId} evt={e} onOpen={() => { setSelected(e); setSource(null); }} onCopy={copy} />
            ))}
          </ul>
          {cursor && (
            <div className="pt-3 flex justify-center">
              <Button variant="outline" onClick={() => void loadNextPage()} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ChevronRight className="h-4 w-4 mr-1.5" />}
                Load more
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LabeledInput({ label, value, placeholder, onChange }: {
  label: string; value: string; placeholder?: string; onChange: (v: string) => void;
}) {
  return (
    <label className="text-xs space-y-1 block">
      <div className="text-muted-foreground">{label}</div>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="font-mono text-sm" />
    </label>
  );
}

function TraceRow({ evt, onOpen, onCopy }: {
  evt: AdminTraceEvent;
  onOpen: () => void;
  onCopy: (t: string, label?: string) => void;
}) {
  const hasFields = evt.fields && Object.keys(evt.fields).length > 0;
  return (
    <li className="py-2.5 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={statusTone(evt.status)}>{evt.status}</Badge>
          <Badge variant="secondary" className="text-xs">{evt.error}</Badge>
          {evt.code && <Badge variant="outline" className="text-xs">{evt.code}</Badge>}
          {hasFields ? (
            <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 border-amber-500/30">
              field errors ({Object.keys(evt.fields!).length})
            </Badge>
          ) : (
            evt.status >= 500 && <Badge variant="outline" className="text-xs bg-rose-500/10 text-rose-600 border-rose-500/30">server</Badge>
          )}
          <span className="text-xs text-muted-foreground">{new Date(evt.at).toLocaleString()}</span>
        </div>
        <div className="text-sm font-mono truncate mt-0.5">
          <span className="text-muted-foreground">{evt.method}</span> {evt.endpoint ?? evt.url}
        </div>
        <div className="text-xs text-muted-foreground truncate">{evt.message}</div>
        <div className="text-[11px] text-muted-foreground font-mono mt-0.5">trace {evt.traceId}</div>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onCopy(evt.traceId, "Trace ID copied")} title="Copy trace ID">
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpen}>Open</Button>
      </div>
    </li>
  );
}

function TraceDetail({ evt, onCopy }: {
  evt: AdminTraceEvent;
  onCopy: (t: string, label?: string) => void;
}) {
  const hasFields = evt.fields && Object.keys(evt.fields).length > 0;
  return (
    <div className="space-y-2 text-sm">
      <KV label="When" value={new Date(evt.at).toLocaleString()} />
      <KV label="Trace ID" value={evt.traceId} mono copy onCopy={onCopy} />
      <KV label="Request" value={`${evt.method} ${evt.url}`} mono />
      {evt.endpoint && <KV label="Endpoint" value={evt.endpoint} mono />}
      <KV label="Message" value={evt.message} />
      {evt.hint && <KV label="Hint" value={evt.hint} />}
      {evt.actorId && <KV label="Actor" value={evt.actorId} mono />}
      {evt.ip && <KV label="IP" value={evt.ip} mono />}

      {hasFields && (
        <div>
          <div className="text-xs font-semibold text-amber-700 mb-1">
            Field errors ({Object.keys(evt.fields!).length}) — validation, not a server bug
          </div>
          <ul className="text-xs space-y-0.5 rounded bg-amber-500/5 border border-amber-500/20 p-2">
            {Object.entries(evt.fields!).map(([k, v]) => (
              <li key={k}><span className="font-mono text-amber-700">{k}</span>: {v}</li>
            ))}
          </ul>
        </div>
      )}

      {evt.stack && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold text-rose-600">
            Stack trace (5xx — server error)
          </summary>
          <pre className="mt-1 text-[11px] whitespace-pre-wrap overflow-auto max-h-64 bg-muted/40 rounded p-2 font-mono">
            {evt.stack}
          </pre>
          <Button size="sm" variant="outline" className="mt-1"
            onClick={() => onCopy(evt.stack!, "Stack copied")}>
            <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy stack
          </Button>
        </details>
      )}

      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="outline"
          onClick={() => onCopy(JSON.stringify(evt, null, 2), "Event JSON copied")}>
          <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy JSON
        </Button>
      </div>
    </div>
  );
}

function KV({ label, value, mono, copy, onCopy }: {
  label: string; value: string; mono?: boolean; copy?: boolean;
  onCopy?: (t: string, l?: string) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-20 shrink-0 text-xs text-muted-foreground">{label}</div>
      <div className={`flex-1 min-w-0 break-all ${mono ? "font-mono text-xs" : "text-sm"}`}>{value}</div>
      {copy && onCopy && (
        <button className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={() => onCopy(value, `${label} copied`)}>
          <Copy className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
