/**
 * Fetch the latest run of a GitHub Actions workflow (public repos only, no auth).
 * Returns null on failure or when the repo/workflow env is not configured.
 *
 * Client-side call — GitHub's public API allows unauthenticated CORS reads.
 */
export type WorkflowRunStatus = {
  id: number;
  name: string | null;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null
  htmlUrl: string;
  runNumber: number;
  event: string;
  headBranch: string | null;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  failingJob?: { name: string; step?: string; url: string } | null;
};

const REPO =
  (import.meta as any).env?.VITE_STARTER_GITHUB_REPO ??
  (import.meta as any).env?.VITE_GITHUB_REPO ??
  "";
const WORKFLOW =
  (import.meta as any).env?.VITE_STARTER_WORKFLOW_FILE ?? "starter-e2e.yml";

export function isConfigured(): boolean {
  return !!REPO && REPO.includes("/");
}

export function repoSlug(): string {
  return REPO;
}

async function gh(path: string): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchLatestStarterRun(): Promise<WorkflowRunStatus | null> {
  if (!isConfigured()) return null;
  try {
    const runs = await gh(
      `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
    );
    const run = runs?.workflow_runs?.[0];
    if (!run) return null;

    let failingJob: WorkflowRunStatus["failingJob"] = null;
    if (run.conclusion === "failure") {
      try {
        const jobs = await gh(`/repos/${REPO}/actions/runs/${run.id}/jobs`);
        const j = (jobs?.jobs ?? []).find((x: any) => x.conclusion === "failure");
        if (j) {
          const failedStep = (j.steps ?? []).find((s: any) => s.conclusion === "failure");
          failingJob = {
            name: j.name,
            step: failedStep?.name,
            url: j.html_url,
          };
        }
      } catch {
        /* jobs endpoint optional */
      }
    }

    return {
      id: run.id,
      name: run.name ?? null,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.html_url,
      runNumber: run.run_number,
      event: run.event,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      failingJob,
    };
  } catch {
    return null;
  }
}
