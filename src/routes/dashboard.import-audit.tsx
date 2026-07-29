import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, RefreshCw, Search } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import {
  importAuditHistoryFn,
  listImportJobsFn,
  type ImportEventView,
  type ImportJobView,
} from "@/lib/pluto/import-job.functions";

export const Route = createFileRoute("/dashboard/import-audit")({
  validateSearch: (s: Record<string, unknown>) => ({ job: typeof s.job === "string" ? s.job : undefined }),
  head: () => ({
    meta: [
      { title: "Import audit history — Pluto" },
      { name: "description", content: "Who imported which repo or Supabase dump, when it was applied, and the resulting row counts or errors." },
      { property: "og:title", content: "Import audit history — Pluto" },
      { property: "og:description", content: "Full audit trail of Pluto Migrator import jobs: actor, source, apply status and results." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ImportAuditPage,
});

function tone(ok: boolean) {
  return ok ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive";
}

function ImportAuditPage() {
  const { job } = Route.useSearch();
  const [events, setEvents] = useState<ImportEventView[]>([]);
  const [jobs, setJobs] = useState<ImportJobView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [actor, setActor] = useState<string>("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [steps, setSteps] = useState<string[]>([]);
  const [actors, setActors] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [h, l] = await Promise.all([
        importAuditHistoryFn({
          data: {
            id: job ?? null,
            limit: pageSize,
            offset: page * pageSize,
            q: query || undefined,
            status,
            actor: actor === "all" ? undefined : actor,
            step,
          },
        }),
        listImportJobsFn(),
      ]);
      if (!h.ok) setErr(h.error);
      else {
        setErr(null);
        setEvents(h.events);
        setTotal(h.total);
        setSteps(h.steps);
        setActors(h.actors);
      }
      if (l.ok) setJobs(l.jobs);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [job, page, pageSize, query, status, actor, step]);

  useEffect(() => { void load(); }, [load]);
  // Any filter change restarts pagination at the first page.
  useEffect(() => { setPage(0); }, [query, status, actor, step, pageSize, job]);

  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const visible = events;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  function exportCsv() {
    const head = ["created_at", "job_id", "source", "repo", "step", "ok", "actor", "row_count", "duration_ms", "message"];
    const rows = visible.map((e) => {
      const j = jobById.get(e.job_id);
      return [e.created_at, e.job_id, j?.source ?? "", j?.repo ?? "", e.step, String(e.ok), e.actor_email ?? "webhook",
        e.row_count ?? "", e.duration_ms ?? "", (e.message ?? "").replace(/"/g, '""')];
    });
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c)}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "pluto-import-audit.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import audit history"
        description="Every Pluto Migrator step: who ran it, from which repo or Supabase dump, whether it was applied, and the resulting rows or error."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select value={step} onChange={(e) => setStep(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-xs">
              <option value="all">All steps</option>
              {steps.map((s2) => <option key={s2} value={s2}>{s2}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-xs">
              <option value="all">Any result</option>
              <option value="ok">Success</option>
              <option value="fail">Failed</option>
            </select>
            <select value={actor} onChange={(e) => setActor(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-xs">
              <option value="all">Any actor</option>
              {actors.map((a2) => <option key={a2} value={a2}>{a2}</option>)}
            </select>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="rounded-md border border-input bg-background px-2 py-1 text-xs">
              {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
            <button onClick={exportCsv} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
              <Download className="h-3 w-3" /> CSV
            </button>
            <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
        }
      />

      <form
        onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}
        className="flex items-center gap-2"
      >
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search schema, table, message, repo or actor…"
            className="w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-xs"
          />
        </div>
        <button type="submit" className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted">Search</button>
        {query && (
          <button type="button" onClick={() => { setQ(""); setQuery(""); }} className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted">Clear</button>
        )}
      </form>

      {job && <div className="text-xs text-muted-foreground">Filtered to job <code className="font-mono">{job}</code>.</div>}
      {err && <div className="text-sm text-destructive">{err}</div>}

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Step</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Result</th>
              <th className="px-3 py-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {!visible.length && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-xs text-muted-foreground">No import activity recorded.</td></tr>
            )}
            {visible.map((e) => {
              const j = jobById.get(e.job_id);
              return (
                <tr key={e.id} className="border-t align-top">
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs ${tone(e.ok)}`}>{e.step}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{e.actor_email ?? "webhook"}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{j?.source ?? "—"}</div>
                    <div className="text-muted-foreground break-all">{j?.repo ?? j?.slug ?? e.job_id}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {e.row_count !== null && <div>{e.row_count} rows</div>}
                    {e.duration_ms !== null && <div className="text-muted-foreground">{e.duration_ms} ms</div>}
                    {j?.applied_at && e.step === "apply" && e.ok && (
                      <div className="text-muted-foreground">applied</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className={e.ok ? "" : "text-destructive"}>{e.message}</div>
                    {e.detail && (
                      <details>
                        <summary className="cursor-pointer text-muted-foreground">log</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{e.detail}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total ? `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} of ${total}` : "0 events"}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 disabled:opacity-40 hover:bg-muted"
          >
            <ChevronLeft className="h-3 w-3" /> Prev
          </button>
          <span>Page {page + 1} / {pageCount}</span>
          <button
            onClick={() => setPage((p) => (p + 1 < pageCount ? p + 1 : p))}
            disabled={page + 1 >= pageCount || loading}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 disabled:opacity-40 hover:bg-muted"
          >
            Next <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
