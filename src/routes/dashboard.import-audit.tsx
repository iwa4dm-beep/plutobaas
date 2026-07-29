import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [h, l] = await Promise.all([
        importAuditHistoryFn({ data: { id: job ?? null, limit: 500 } }),
        listImportJobsFn(),
      ]);
      if (!h.ok) setErr(h.error);
      else { setErr(null); setEvents(job ? h.events : h.events); }
      if (l.ok) setJobs(l.jobs);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [job]);

  useEffect(() => { void load(); }, [load]);

  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const visible = step === "all" ? events : events.filter((e) => e.step === step);

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
          <div className="flex items-center gap-2">
            <select value={step} onChange={(e) => setStep(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-xs">
              <option value="all">All steps</option>
              <option value="received">Received</option>
              <option value="translated">Translated</option>
              <option value="selection_changed">Selection</option>
              <option value="dry_run">Dry-run</option>
              <option value="apply">Apply</option>
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
    </div>
  );
}
