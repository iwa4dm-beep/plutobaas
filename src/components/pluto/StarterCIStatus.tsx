import { useEffect, useState } from "react";
import {
  fetchLatestStarterRun,
  isConfigured,
  repoSlug,
  type WorkflowRunStatus,
} from "@/lib/starter-ci";

function badgeStyle(run: WorkflowRunStatus | null) {
  if (!run) return { bg: "bg-muted", label: "unknown", tone: "text-muted-foreground" };
  if (run.status !== "completed")
    return { bg: "bg-amber-500/15", label: run.status, tone: "text-amber-700 dark:text-amber-300" };
  switch (run.conclusion) {
    case "success":
      return { bg: "bg-emerald-500/15", label: "pass", tone: "text-emerald-700 dark:text-emerald-300" };
    case "failure":
      return { bg: "bg-rose-500/15", label: "fail", tone: "text-rose-700 dark:text-rose-300" };
    case "cancelled":
      return { bg: "bg-muted", label: "cancelled", tone: "text-muted-foreground" };
    default:
      return { bg: "bg-muted", label: run.conclusion ?? "n/a", tone: "text-muted-foreground" };
  }
}

export function StarterCIStatus() {
  const [run, setRun] = useState<WorkflowRunStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  async function refresh() {
    setLoading(true);
    const r = await fetchLatestStarterRun();
    setRun(r);
    setRefreshedAt(Date.now());
    setLoading(false);
  }

  useEffect(() => {
    if (!isConfigured()) return;
    refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, []);

  if (!isConfigured()) {
    return (
      <div className="rounded-md border p-3 text-xs text-muted-foreground">
        Set <code className="px-1 py-0.5 rounded bg-muted">VITE_STARTER_GITHUB_REPO=owner/repo</code>{" "}
        to display the latest Playwright CI run for{" "}
        <code className="px-1 py-0.5 rounded bg-muted">starter-e2e.yml</code>.
      </div>
    );
  }

  const b = badgeStyle(run);
  return (
    <div className="rounded-md border p-3 space-y-2 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 rounded ${b.bg} ${b.tone} text-xs font-medium uppercase tracking-wide`}>
          {loading ? "…" : b.label}
        </span>
        <span className="font-medium">Starter E2E</span>
        {run && (
          <a
            href={run.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline text-primary"
          >
            run #{run.runNumber} ↗
          </a>
        )}
        <button
          type="button"
          onClick={refresh}
          className="ml-auto text-xs px-2 py-0.5 rounded border hover:bg-accent"
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      {run ? (
        <div className="text-xs text-muted-foreground space-x-2">
          <span>
            {repoSlug()} · {run.event}
          </span>
          <span>· {run.headBranch ?? run.headSha.slice(0, 7)}</span>
          <span>· {new Date(run.updatedAt).toLocaleString()}</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          {loading ? "Fetching…" : "No runs yet for this workflow."}
        </div>
      )}

      {run?.conclusion === "failure" && run.failingJob && (
        <div className="rounded border border-rose-500/40 bg-rose-500/5 p-2 text-xs">
          <div className="font-medium text-rose-700 dark:text-rose-300">
            Failing job: {run.failingJob.name}
          </div>
          {run.failingJob.step && (
            <div className="text-rose-700/80 dark:text-rose-300/80">
              Step: <code>{run.failingJob.step}</code>
            </div>
          )}
          <a
            href={run.failingJob.url}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View job logs ↗
          </a>
        </div>
      )}
      {refreshedAt && (
        <div className="text-[10px] text-muted-foreground">
          auto-refreshes every 60s
        </div>
      )}
    </div>
  );
}
