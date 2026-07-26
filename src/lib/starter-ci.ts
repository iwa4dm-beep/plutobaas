/**
 * GitHub Actions helper for the Pluto starter E2E workflow.
 * Public repos only — uses unauthenticated GitHub REST (CORS-enabled).
 */
export type WorkflowRunStatus = {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  runNumber: number;
  runAttempt: number;
  event: string;
  headBranch: string | null;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  displayTitle?: string | null;
  failingJob?: {
    name: string;          // pretty test/step name when detectable
    rawJobName: string;    // original job label ("Playwright E2E" or matrix leg)
    step?: string;
    matrix?: Record<string, unknown> | null;
    url: string;
  } | null;
};

const REPO =
  (import.meta as any).env?.VITE_STARTER_GITHUB_REPO ??
  (import.meta as any).env?.VITE_GITHUB_REPO ?? "";
const WORKFLOW =
  (import.meta as any).env?.VITE_STARTER_WORKFLOW_FILE ?? "starter-e2e.yml";

export function isConfigured(): boolean {
  return !!REPO && REPO.includes("/");
}
export function repoSlug(): string { return REPO; }
export function workflowFile(): string { return WORKFLOW; }

async function gh(path: string): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Extract a friendly test-name from a step. Playwright step names look like
 *  "› tests/e2e.spec.ts:42 › Auth + RLS › Alice can update…" or the raw
 *  script line. We prefer the last "›" segment, fall back to step name. */
function prettifyStepName(step: string | undefined): string | undefined {
  if (!step) return undefined;
  const arrow = step.split("›").map((s) => s.trim()).filter(Boolean);
  if (arrow.length >= 2) return arrow[arrow.length - 1];
  // "Run E2E tests" / "npm run test:e2e" → strip common prefixes.
  return step.replace(/^Run\s+/, "").replace(/^npm run\s+/, "");
}

function matrixFromJob(job: any): Record<string, unknown> | null {
  // GH exposes matrix values in the job name suffix like "Playwright E2E (chromium, 20.x)".
  // The REST API doesn't return the matrix object directly, so we parse `(a, b)` if present.
  const m = /\(([^)]+)\)\s*$/.exec(job?.name ?? "");
  if (!m) return null;
  const parts = m[1].split(",").map((s) => s.trim());
  return parts.length ? { values: parts } : null;
}

async function extractFailingJob(runId: number): Promise<WorkflowRunStatus["failingJob"]> {
  try {
    // include re-run attempts by paginating jobs; GH returns latest attempt by default.
    const jobs = await gh(`/repos/${REPO}/actions/runs/${runId}/jobs?per_page=100&filter=latest`);
    const failed = (jobs?.jobs ?? []).filter((x: any) => x.conclusion === "failure");
    if (!failed.length) return null;
    // Prefer the deepest (last) failing job — matrix legs & retries surface after root.
    const j = failed[failed.length - 1];
    const failedStep = (j.steps ?? []).find((s: any) => s.conclusion === "failure");
    const pretty = prettifyStepName(failedStep?.name);
    return {
      name: pretty ?? j.name,
      rawJobName: j.name,
      step: failedStep?.name,
      matrix: matrixFromJob(j),
      url: j.html_url,
    };
  } catch {
    return null;
  }
}

function toStatus(run: any, failingJob: WorkflowRunStatus["failingJob"] = null): WorkflowRunStatus {
  return {
    id: run.id,
    name: run.name ?? null,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    runNumber: run.run_number,
    runAttempt: run.run_attempt ?? 1,
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    displayTitle: run.display_title ?? null,
    failingJob,
  };
}

export async function fetchLatestStarterRun(branch?: string): Promise<WorkflowRunStatus | null> {
  if (!isConfigured()) return null;
  try {
    const qs = new URLSearchParams({ per_page: "1" });
    if (branch) qs.set("branch", branch);
    const runs = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?${qs}`);
    const run = runs?.workflow_runs?.[0];
    if (!run) return null;
    const failing = run.conclusion === "failure" ? await extractFailingJob(run.id) : null;
    return toStatus(run, failing);
  } catch {
    return null;
  }
}

export async function fetchLastSuccessfulStarterRun(branch?: string): Promise<WorkflowRunStatus | null> {
  if (!isConfigured()) return null;
  try {
    const qs = new URLSearchParams({ per_page: "1", status: "success" });
    if (branch) qs.set("branch", branch);
    const runs = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?${qs}`);
    const run = runs?.workflow_runs?.[0];
    return run ? toStatus(run, null) : null;
  } catch {
    return null;
  }
}

/** Distinct branches seen across recent workflow runs (approx — REST has no
 *  dedicated endpoint for "branches that ran this workflow"). */
export async function fetchRecentBranches(limit = 50): Promise<string[]> {
  if (!isConfigured()) return [];
  try {
    const runs = await gh(
      `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=${limit}`,
    );
    const set = new Set<string>();
    for (const r of runs?.workflow_runs ?? []) {
      if (r.head_branch) set.add(r.head_branch);
    }
    return Array.from(set);
  } catch {
    return [];
  }
}
