import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { retryJob, subscribe, type PurgeJob } from "@/lib/pluto/delete-store";

export const Route = createFileRoute("/dashboard/jobs")({
  head: () => ({ meta: [
    { title: "Purge jobs — Pluto" },
    { name: "description", content: "Live status of soft-delete purge jobs, including retries and VPS purge details." },
  ]}),
  component: JobsPage,
});

const statusStyles: Record<PurgeJob["status"], string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-primary/10 text-primary",
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

function JobsPage() {
  const [jobs, setJobs] = useState<PurgeJob[]>([]);
  const [filter, setFilter] = useState<"all" | PurgeJob["status"]>("all");
  useEffect(() => subscribe((s) => setJobs(s.jobs)), []);
  const visible = filter === "all" ? jobs : jobs.filter((j) => j.status === filter);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purge jobs"
        description="Background purge jobs for soft-deleted users and projects. Failed jobs can be retried."
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs">
            <option value="all">All ({jobs.length})</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="ok">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        }
      />

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Attempts</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2">Detail</th>
              <th className="px-3 py-2 w-20" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-xs text-muted-foreground">No jobs.</td></tr>
            )}
            {visible.map((j) => (
              <tr key={j.id} className="border-t align-top">
                <td className="px-3 py-2">
                  <span className={`inline-flex rounded px-1.5 py-0.5 text-xs ${statusStyles[j.status]}`}>{j.status}</span>
                </td>
                <td className="px-3 py-2 text-xs uppercase">{j.kind}</td>
                <td className="px-3 py-2">
                  <div>{j.label}</div>
                  {j.slug && <div className="text-xs font-mono text-muted-foreground">{j.slug}</div>}
                </td>
                <td className="px-3 py-2 text-xs">{j.attempts}</td>
                <td className="px-3 py-2 text-xs">{new Date(j.updatedAt).toLocaleString()}</td>
                <td className="px-3 py-2 text-xs">
                  {j.dbError && <div className="text-destructive break-all">DB: {j.dbError}</div>}
                  {j.lastError && !j.dbError && <div className="text-destructive break-all">{j.lastError}</div>}
                  {j.hint && <div className="text-muted-foreground break-all">Hint: {j.hint}</div>}
                  {j.removed?.length ? <div className="text-muted-foreground">Removed {j.removed.length} path{j.removed.length === 1 ? "" : "s"}</div> : null}
                  {j.status === "queued" && <div className="text-muted-foreground">Runs at {new Date(j.runAfter).toLocaleTimeString()}</div>}
                </td>
                <td className="px-3 py-2 text-right">
                  {(j.status === "failed" || j.status === "cancelled") && (
                    <button onClick={() => retryJob(j.id)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
                      <RefreshCw className="h-3 w-3" /> Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
