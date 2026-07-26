import { useCallback, useEffect, useMemo, useState } from "react";
import {
  dispatchStarterWorkflow,
  fetchLatestStarterRun,
  fetchLastSuccessfulStarterRun,
  fetchRecentBranches,
  getStoredToken,
  isConfigured,
  repoSlug,
  setStoredToken,
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
const BROWSER_OPTIONS = ["chromium", "firefox", "webkit"] as const;
const NODE_OPTIONS = ["18", "20", "22"] as const;
type Browser = (typeof BROWSER_OPTIONS)[number];
type NodeVer = (typeof NODE_OPTIONS)[number];

export function StarterCIStatus() {
  const [run, setRun] = useState<WorkflowRunStatus | null>(null);
  const [lastGreen, setLastGreen] = useState<WorkflowRunStatus | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState<string>(ALL);
  const [loading, setLoading] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);
  const [browsers, setBrowsers] = useState<Browser[]>(["chromium"]);
  const [nodeVersions, setNodeVersions] = useState<NodeVer[]>(["20"]);

  const activeBranch = branch === ALL ? undefined : branch;

  useEffect(() => { setHasToken(!!getStoredToken()); }, []);

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

  const dispatch = async () => {
    if (!activeBranch) {
      setDispatchMsg("Pick a specific branch first (not 'all').");
      return;
    }
    if (!browsers.length || !nodeVersions.length) {
      setDispatchMsg("Pick at least one browser and one Node version.");
      return;
    }
    setDispatching(true);
    setDispatchMsg(null);
    const res = await dispatchStarterWorkflow(activeBranch, {
      note: "triggered from dashboard",
      browsers: browsers.join(","),
      node_versions: nodeVersions.join(","),
    });
    if (res.ok) {
      setDispatchMsg(
        `Dispatched on ${activeBranch} · browsers=${browsers.join(",")} · node=${nodeVersions.join(",")}. New run in ~5s…`,
      );
      let n = 0;
      const t = window.setInterval(async () => {
        n++;
        await refresh();
        if (n >= 10) window.clearInterval(t);
      }, 3000);
    } else {
      setDispatchMsg(`Dispatch failed (${res.status}): ${res.message}`);
    }
    setDispatching(false);
  };

  const rerunFailedLegs = async () => {
    const legs = run?.failingLegs ?? [];
    if (!legs.length) return;
    const targetBranch = run?.headBranch ?? activeBranch;
    if (!targetBranch) {
      setDispatchMsg("Cannot determine the branch for the failed run.");
      return;
    }
    const uniq = <T extends string>(xs: (T | undefined)[]) =>
      Array.from(new Set(xs.filter((x): x is T => !!x)));
    const brs = uniq(legs.map((l) => l.browser as Browser | undefined));
    const nds = uniq(legs.map((l) => l.node as NodeVer | undefined));
    if (!brs.length || !nds.length) {
      setDispatchMsg("Could not parse matrix values from failing jobs — dispatch skipped.");
      return;
    }
    setDispatching(true);
    setDispatchMsg(null);
    const res = await dispatchStarterWorkflow(targetBranch, {
      note: `rerun failed legs from run #${run?.runNumber}`,
      browsers: brs.join(","),
      node_versions: nds.join(","),
    });
    if (res.ok) {
      setDispatchMsg(
        `Re-dispatched ${brs.length * nds.length} leg${brs.length * nds.length === 1 ? "" : "s"} on ${targetBranch} · browsers=${brs.join(",")} · node=${nds.join(",")}.`,
      );
      let n = 0;
      const t = window.setInterval(async () => {
        n++;
        await refresh();
        if (n >= 10) window.clearInterval(t);
      }, 3000);
    } else {
      setDispatchMsg(`Dispatch failed (${res.status}): ${res.message}`);
    }
    setDispatching(false);
  };


  const toggle = <T extends string>(
    val: T,
    list: T[],
    setter: (v: T[]) => void,
  ) => {
    setter(list.includes(val) ? list.filter((x) => x !== val) : [...list, val]);
  };

  const saveToken = () => {
    setStoredToken(tokenInput.trim());
    setHasToken(!!tokenInput.trim());
    setTokenInput("");
    setShowToken(false);
    refresh();
  };

  // Matrix suffix now attaches (`playwright-report-chromium-node20`) — match by prefix.
  const playwrightArtifact = run?.artifacts?.find(
    (a) => a.name.startsWith("playwright-report") && !a.expired,
  );
  const debugArtifact = run?.artifacts?.find(
    (a) => a.name.startsWith("playwright-artifacts") && !a.expired,
  );
  const allReportArtifacts =
    run?.artifacts?.filter((a) => a.name.startsWith("playwright-report") && !a.expired) ?? [];
  const allDebugArtifacts =
    run?.artifacts?.filter((a) => a.name.startsWith("playwright-artifacts") && !a.expired) ?? [];

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
        <button
          type="button"
          onClick={dispatch}
          disabled={dispatching || !hasToken || branch === ALL || !browsers.length || !nodeVersions.length}
          title={
            !hasToken ? "Save a GitHub PAT below to enable" :
            branch === ALL ? "Pick a branch first" :
            !browsers.length || !nodeVersions.length ? "Pick at least one browser and Node version" :
            "Trigger workflow_dispatch"
          }
          className="text-xs px-2 py-0.5 rounded border bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {dispatching ? "Running…" : "Run E2E tests"}
        </button>
        {run?.conclusion === "failure" && (run.failingLegs?.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={rerunFailedLegs}
            disabled={dispatching || !hasToken}
            title={!hasToken ? "Save a GitHub PAT below to enable" : "Re-dispatch only the matrix legs that failed last time"}
            className="text-xs px-2 py-0.5 rounded border bg-rose-600 text-white hover:opacity-90 disabled:opacity-50"
          >
            {dispatching ? "Running…" : `Rerun failed legs (${run.failingLegs!.length})`}
          </button>
        )}
      </div>


      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="text-muted-foreground">Matrix:</span>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">browsers</span>
          {BROWSER_OPTIONS.map((br) => (
            <label
              key={br}
              className={`px-1.5 py-0.5 rounded border cursor-pointer select-none ${
                browsers.includes(br) ? "bg-primary/10 border-primary/40" : "hover:bg-accent"
              }`}
            >
              <input
                type="checkbox"
                className="hidden"
                checked={browsers.includes(br)}
                onChange={() => toggle(br, browsers, setBrowsers)}
              />
              {br}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">node</span>
          {NODE_OPTIONS.map((nv) => (
            <label
              key={nv}
              className={`px-1.5 py-0.5 rounded border cursor-pointer select-none ${
                nodeVersions.includes(nv) ? "bg-primary/10 border-primary/40" : "hover:bg-accent"
              }`}
            >
              <input
                type="checkbox"
                className="hidden"
                checked={nodeVersions.includes(nv)}
                onChange={() => toggle(nv, nodeVersions, setNodeVersions)}
              />
              {nv}
            </label>
          ))}
        </div>
        <span className="text-muted-foreground">
          → {browsers.length * nodeVersions.length} leg{browsers.length * nodeVersions.length === 1 ? "" : "s"}
        </span>
      </div>

      {dispatchMsg && (
        <div className="text-xs rounded border border-primary/30 bg-primary/5 p-2">{dispatchMsg}</div>
      )}

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
        <div className="rounded border border-rose-500/40 bg-rose-500/5 p-2 text-xs space-y-1">
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
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
            <a href={run.failingJob.url} target="_blank" rel="noreferrer" className="underline">
              Open failing step ↗
            </a>
            {allReportArtifacts.length > 0 && (
              <span className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">HTML report:</span>
                {allReportArtifacts.map((a) => (
                  <a key={a.id} href={a.htmlUrl} target="_blank" rel="noreferrer" className="underline">
                    {a.name.replace(/^playwright-report-?/, "") || "default"} ↗
                  </a>
                ))}
              </span>
            )}
            {allDebugArtifacts.length > 0 && (
              <span className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">Traces:</span>
                {allDebugArtifacts.map((a) => (
                  <a key={a.id} href={a.htmlUrl} target="_blank" rel="noreferrer" className="underline">
                    {a.name.replace(/^playwright-artifacts-?/, "") || "default"} ↗
                  </a>
                ))}
              </span>
            )}
          </div>
        </div>
      )}

      {run?.conclusion !== "failure" && (playwrightArtifact || debugArtifact) && (
        <div className="text-[11px] text-muted-foreground space-x-3">
          {playwrightArtifact && (
            <a href={playwrightArtifact.htmlUrl} target="_blank" rel="noreferrer" className="underline">
              Playwright report ↗
            </a>
          )}
          {debugArtifact && (
            <a href={debugArtifact.htmlUrl} target="_blank" rel="noreferrer" className="underline">
              Debug artifacts ↗
            </a>
          )}
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

      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div>
          {refreshedAt && (
            <>
              {autoRefresh ? "auto-refreshes every 60s · " : ""}
              last refresh {new Date(refreshedAt).toLocaleTimeString()}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowToken((v) => !v)}
          className="underline hover:text-foreground"
        >
          {hasToken ? "GitHub PAT: saved" : "Add GitHub PAT to enable dispatch"}
        </button>
      </div>

      {showToken && (
        <div className="rounded border p-2 text-xs space-y-2 bg-muted/40">
          <div className="text-muted-foreground">
            Paste a fine-grained PAT with <strong>Actions: Read &amp; Write</strong> on{" "}
            <code>{repoSlug()}</code>. Stored in your browser's localStorage only.
          </div>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="github_pat_…"
            className="w-full px-2 py-1 rounded border bg-background"
          />
          <div className="flex gap-2">
            <button onClick={saveToken} className="px-2 py-0.5 rounded border bg-primary text-primary-foreground">
              Save
            </button>
            <button
              onClick={() => { setStoredToken(""); setHasToken(false); setTokenInput(""); }}
              className="px-2 py-0.5 rounded border"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {dispatchMsg && (
        <div className="text-[11px] text-muted-foreground">{dispatchMsg}</div>
      )}
    </div>
  );
}
