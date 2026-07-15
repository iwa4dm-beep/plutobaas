import { createFileRoute } from '@tanstack/react-router'
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getCiStatus, getPublishStatus, type WorkflowRunSummary } from "@/lib/ci/github-status.functions";

export const Route = createFileRoute("/dashboard/ci-status")({
  head: () => ({
    meta: [
      { title: "CI / Test Status — Pluto BaaS" },
      { name: "description", content: "Auto-Connect E2E, workflow runs per PR/commit, and publish status for the Pluto BaaS Auto-Connect Studio." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CiStatusPage,
});

function statusBadge(run: WorkflowRunSummary) {
  const key = run.conclusion ?? run.status;
  const map: Record<string, string> = {
    success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    failure: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
    cancelled: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
    skipped: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
    in_progress: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
    queued: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  };
  const cls = map[key] ?? "bg-muted text-foreground border-border";
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs ${cls}`}>{key}</span>;
}

function CiStatusPage() {
  const ci = useServerFn(getCiStatus);
  const pub = useServerFn(getPublishStatus);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [workflow, setWorkflow] = useState("");

  const publish = useQuery({
    queryKey: ["publish-status"],
    queryFn: () => pub({}),
    staleTime: 60_000,
  });

  const runs = useQuery({
    queryKey: ["ci-status", owner, repo, workflow],
    queryFn: () => ci({ data: { owner: owner || undefined, repo: repo || undefined, workflow: workflow || undefined } }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const data = runs.data;
  const grouped = groupByCommit(data?.runs ?? []);
  const guardRuns = (data?.runs ?? []).filter((r) => /auto-?connect/i.test(r.name));

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">CI / Test Status</h1>
        <p className="text-sm text-muted-foreground">
          Auto-Connect Guard, unit tests, and publish status. Runs are grouped by commit; expand a commit to see every workflow that ran against it.
        </p>
      </header>

      <section className="rounded-lg border p-4 space-y-2">
        <h2 className="font-medium">Publish</h2>
        {publish.data && (
          <div className="grid gap-2 md:grid-cols-3 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Preview</div>
              <a className="underline break-all" href={publish.data.previewUrl} target="_blank" rel="noreferrer">{publish.data.previewUrl}</a>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Published</div>
              <a className="underline break-all" href={publish.data.publishedUrl} target="_blank" rel="noreferrer">{publish.data.publishedUrl}</a>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Custom domains</div>
              {publish.data.customDomains.length === 0 ? (
                <div className="text-xs text-muted-foreground">None connected. See docs/CUSTOM-DOMAIN-SETUP.md.</div>
              ) : (
                <ul className="text-sm">
                  {publish.data.customDomains.map((d) => (
                    <li key={d}><a className="underline" href={`https://${d}`} target="_blank" rel="noreferrer">{d}</a></li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs space-y-1">
            <div className="text-muted-foreground">Owner</div>
            <input aria-label="owner" className="border rounded px-2 py-1 text-sm" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={data?.owner || "octo-org"} />
          </label>
          <label className="text-xs space-y-1">
            <div className="text-muted-foreground">Repo</div>
            <input aria-label="repo" className="border rounded px-2 py-1 text-sm" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={data?.repo || "pluto-baas"} />
          </label>
          <label className="text-xs space-y-1">
            <div className="text-muted-foreground">Workflow file (optional)</div>
            <input aria-label="workflow" className="border rounded px-2 py-1 text-sm" value={workflow} onChange={(e) => setWorkflow(e.target.value)} placeholder="autoconnect-guard.yml" />
          </label>
          <button className="ml-auto px-3 py-1 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50" disabled={runs.isFetching} onClick={() => runs.refetch()}>
            {runs.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {runs.isLoading && <div className="text-sm text-muted-foreground">Loading workflow runs…</div>}
        {data && !data.ok && <div className="text-sm text-destructive">Error: {data.error}</div>}

        {data?.ok && (
          <>
            <SummaryStrip runs={data.runs} guardRuns={guardRuns} />
            <div className="space-y-3">
              <h3 className="font-medium text-sm mt-3">Auto-Connect Guard runs</h3>
              <RunTable runs={guardRuns.slice(0, 10)} emptyLabel="No Auto-Connect Guard runs found for this repo." />
            </div>
            <div className="space-y-3">
              <h3 className="font-medium text-sm mt-4">By commit ({grouped.length})</h3>
              {grouped.length === 0 && <div className="text-xs text-muted-foreground">No runs found.</div>}
              {grouped.map((g) => (
                <details key={g.sha} className="rounded border">
                  <summary className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2 flex-wrap">
                    <code className="text-xs">{g.sha.slice(0, 7)}</code>
                    <span className="text-muted-foreground">{g.branch ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">{g.runs.length} runs</span>
                    <span className="ml-auto flex gap-1">{aggregateBadges(g.runs)}</span>
                  </summary>
                  <div className="border-t p-2">
                    <RunTable runs={g.runs} emptyLabel="" />
                  </div>
                </details>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SummaryStrip({ runs, guardRuns }: { runs: WorkflowRunSummary[]; guardRuns: WorkflowRunSummary[] }) {
  const stats = summarize(runs);
  const guardLatest = guardRuns[0];
  return (
    <div className="grid gap-2 md:grid-cols-4 text-sm">
      <Stat label="Total runs" value={String(runs.length)} />
      <Stat label="Success" value={String(stats.success)} tone="ok" />
      <Stat label="Failure" value={String(stats.failure)} tone={stats.failure ? "err" : undefined} />
      <Stat label="Auto-Connect Guard" value={guardLatest ? (guardLatest.conclusion ?? guardLatest.status) : "—"} tone={guardLatest?.conclusion === "success" ? "ok" : guardLatest?.conclusion === "failure" ? "err" : undefined} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "err" }) {
  const cls = tone === "ok" ? "text-emerald-600" : tone === "err" ? "text-red-600" : "";
  return (
    <div className="rounded border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function RunTable({ runs, emptyLabel }: { runs: WorkflowRunSummary[]; emptyLabel: string }) {
  if (runs.length === 0) return <div className="text-xs text-muted-foreground">{emptyLabel}</div>;
  return (
    <div className="overflow-auto">
      <table className="text-xs w-full">
        <thead className="bg-muted">
          <tr>
            <th className="text-left px-2 py-1">Workflow</th>
            <th className="text-left px-2 py-1">Status</th>
            <th className="text-left px-2 py-1">Branch</th>
            <th className="text-left px-2 py-1">SHA</th>
            <th className="text-left px-2 py-1">PR</th>
            <th className="text-left px-2 py-1">When</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="px-2 py-1"><a className="underline" href={r.html_url} target="_blank" rel="noreferrer">{r.name} #{r.run_number}</a></td>
              <td className="px-2 py-1">{statusBadge(r)}</td>
              <td className="px-2 py-1">{r.head_branch ?? "—"}</td>
              <td className="px-2 py-1"><code>{r.head_sha.slice(0, 7)}</code></td>
              <td className="px-2 py-1">{r.pull_requests[0] ? `#${r.pull_requests[0].number}` : "—"}</td>
              <td className="px-2 py-1 text-muted-foreground">{new Date(r.updated_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarize(runs: WorkflowRunSummary[]) {
  return runs.reduce(
    (acc, r) => {
      if (r.conclusion === "success") acc.success++;
      else if (r.conclusion === "failure") acc.failure++;
      return acc;
    },
    { success: 0, failure: 0 },
  );
}

function groupByCommit(runs: WorkflowRunSummary[]): Array<{ sha: string; branch: string | null; runs: WorkflowRunSummary[] }> {
  const map = new Map<string, { sha: string; branch: string | null; runs: WorkflowRunSummary[] }>();
  for (const r of runs) {
    const g = map.get(r.head_sha) ?? { sha: r.head_sha, branch: r.head_branch, runs: [] };
    g.runs.push(r);
    map.set(r.head_sha, g);
  }
  return Array.from(map.values()).slice(0, 20);
}

function aggregateBadges(runs: WorkflowRunSummary[]) {
  const counts: Record<string, number> = {};
  for (const r of runs) {
    const k = r.conclusion ?? r.status;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => (
    <span key={k} className="text-[10px] px-1.5 py-0.5 rounded border bg-muted">{k}:{v}</span>
  ));
}
