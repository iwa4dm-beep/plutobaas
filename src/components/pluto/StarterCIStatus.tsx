import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchLatestStarterRun,
  fetchLastSuccessfulStarterRun,
  fetchRecentBranches,
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

const ALL = "__all__";

export function StarterCIStatus() {
  const [run, setRun] = useState<WorkflowRunStatus | null>(null);
  const [lastGreen, setLastGreen] = useState<WorkflowRunStatus | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState<string>(ALL);
  const [loading, setLoading] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const activeBranch = branch === ALL ? undefined : branch;

  const refresh = useCallback(async () => {
    setLoading(true);
    const [latest, green] = await Promise.all([
      fetchLatestStarterRun(activeBranch),
      fetchLastSuccessfulStarterRun(activeBranch),
    ]);
    setRun(latest);
    setLastGreen(green);
    setRefreshedAt(Date.now());
    setLoading(false);
  }, [activeBranch]);

  useEffect(() => {
    if (!isConfigured()) return;
    fetchRecentBranches().then(setBranches).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isConfigured()) return;
    refresh();
    if (!autoRefresh) return;
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, [refresh, autoRefresh]);

  const b = useMemo(() => badgeStyle(run), [run]);

  if (!isConfigured()) {
    return (
      <div className="rounded-md border p-3 text-xs text-muted-foreground">
        Set <code className="px-1 py-0.5 rounded bg-muted">VITE_STARTER_GITHUB_REPO=owner/repo</code>{" "}
        to display the latest Playwright CI run for{" "}
        <code className="px-1 py-0.5 rounded bg-muted">starter-e2e.yml</code>.
      </div>
    );
  }

  return (
    <div className="rounded-md border p-3 space-y-2 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 rounded ${b.bg} ${b.tone} text-xs font-medium uppercase tracking-wide`}>
          {loading ? "…" : b.label}
        </span>
        <span className="font-medium">Starter E2E</span>
        {run && (
          <a href={run.htmlUrl} target="_blank" rel="noreferrer" className="text-xs underline text-primary">
            run #{run.runNumber}
            {run.runAttempt > 1 ? ` · attempt ${run.runAttempt}` : ""} ↗
          </a>
        )}

        <label className="ml-auto flex items-center gap-1 text-xs">
          <span className="text-muted-foreground">branch</span>
          <select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="px-1.5 py-0.5 rounded border bg-background text-xs max-w-[10rem]"
          >
            <option value={ALL}>all</option>
            {branches.map((br) => (
              <option key={br} value={br}>{br}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          auto
        </label>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs px-2 py-0.5 rounded border hover:bg-accent disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {run ? (
        <div className="text-xs text-muted-foreground space-x-2">
          <span>{repoSlug()} · {run.event}</span>
          <span>· {run.headBranch ?? run.headSha.slice(0, 7)}</span>
          <span>· {new Date(run.updatedAt).toLocaleString()}</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          {loading ? "Fetching…" : "No runs yet for this filter."}
        </div>
      )}

      {run?.conclusion === "failure" && run.failingJob && (
        <div className="rounded border border-rose-500/40 bg-rose-500/5 p-2 text-xs space-y-0.5">
          <div className="font-medium text-rose-700 dark:text-rose-300">
            Failing test: {run.failingJob.name}
          </div>
          <div className="text-rose-700/80 dark:text-rose-300/80">
            Job: <code>{run.failingJob.rawJobName}</code>
            {run.failingJob.matrix?.values ? (
              <> · matrix <code>{(run.failingJob.matrix.values as string[]).join(", ")}</code></>
            ) : null}
          </div>
          {run.failingJob.step && run.failingJob.step !== run.failingJob.name && (
            <div className="text-rose-700/80 dark:text-rose-300/80">
              Step: <code>{run.failingJob.step}</code>
            </div>
          )}
          <a href={run.failingJob.url} target="_blank" rel="noreferrer" className="underline">
            View job logs ↗
          </a>
        </div>
      )}

      {lastGreen && (!run || run.id !== lastGreen.id) && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs">
          <span className="text-emerald-700 dark:text-emerald-300 font-medium">
            Last successful run:
          </span>{" "}
          <a href={lastGreen.htmlUrl} target="_blank" rel="noreferrer" className="underline">
            #{lastGreen.runNumber}
          </a>{" "}
          <span className="text-muted-foreground">
            on {lastGreen.headBranch ?? lastGreen.headSha.slice(0, 7)} ·{" "}
            {new Date(lastGreen.updatedAt).toLocaleString()}
          </span>
        </div>
      )}

      {refreshedAt && (
        <div className="text-[10px] text-muted-foreground">
          {autoRefresh ? "auto-refreshes every 60s · " : ""}
          last refresh {new Date(refreshedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
