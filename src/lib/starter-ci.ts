/**
 * GitHub Actions helper for the Pluto starter E2E workflow.
 * Public repos only for read paths (unauthenticated GitHub REST). The
 * workflow_dispatch trigger requires a user-supplied PAT with `actions:write`.
 */
export type WorkflowArtifact = {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
  htmlUrl: string;       // browser download (auth-gated by GitHub UI)
  apiDownloadUrl: string; // requires token, exposed for scripts
};

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
    name: string;
    rawJobName: string;
    step?: string;
    matrix?: Record<string, unknown> | null;
    url: string;               // exact failing job/step deep link
  } | null;
  artifacts?: WorkflowArtifact[];
  failingLegs?: FailingLeg[];
};

/** A single failed matrix leg — enough to re-dispatch just that leg. */
export type FailingLeg = {
  browser?: string;
  node?: string;
  rawJobName: string;
  jobUrl: string;
  jobLogsUrl: string;   // GitHub UI page (renders logs inline)
  rawLogsUrl: string;   // REST endpoint returning raw log text
};


const REPO =
  (import.meta as any).env?.VITE_STARTER_GITHUB_REPO ??
  (import.meta as any).env?.VITE_GITHUB_REPO ?? "";
const WORKFLOW =
  (import.meta as any).env?.VITE_STARTER_WORKFLOW_FILE ?? "starter-e2e.yml";

const TOKEN_KEY = "pluto.starter.gh_pat.v1";

export function isConfigured(): boolean {
  return !!REPO && REPO.includes("/");
}
export function repoSlug(): string { return REPO; }
export function workflowFile(): string { return WORKFLOW; }

export function getStoredToken(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}
export function setStoredToken(v: string) {
  if (typeof window === "undefined") return;
  try {
    if (v) window.localStorage.setItem(TOKEN_KEY, v);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`https://api.github.com${path}`, { ...init, headers });
}

async function ghJson(path: string): Promise<any> {
  const res = await gh(path);
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

function prettifyStepName(step: string | undefined): string | undefined {
  if (!step) return undefined;
  const arrow = step.split("›").map((s) => s.trim()).filter(Boolean);
  if (arrow.length >= 2) return arrow[arrow.length - 1];
  return step.replace(/^Run\s+/, "").replace(/^npm run\s+/, "");
}

function matrixFromJob(job: any): Record<string, unknown> | null {
  const m = /\(([^)]+)\)\s*$/.exec(job?.name ?? "");
  if (!m) return null;
  const parts = m[1].split(",").map((s) => s.trim());
  return parts.length ? { values: parts } : null;
}

async function extractFailingJob(runId: number): Promise<WorkflowRunStatus["failingJob"]> {
  try {
    const jobs = await ghJson(`/repos/${REPO}/actions/runs/${runId}/jobs?per_page=100&filter=latest`);
    const failed = (jobs?.jobs ?? []).filter((x: any) => x.conclusion === "failure");
    if (!failed.length) return null;
    const j = failed[failed.length - 1];
    const failedStep = (j.steps ?? []).find((s: any) => s.conclusion === "failure");
    const pretty = prettifyStepName(failedStep?.name);
    // Deep link to the failing step (GitHub UI supports #step:<number>:<line>).
    const stepUrl = failedStep?.number
      ? `${j.html_url}#step:${failedStep.number}:1`
      : j.html_url;
    return {
      name: pretty ?? j.name,
      rawJobName: j.name,
      step: failedStep?.name,
      matrix: matrixFromJob(j),
      url: stepUrl,
    };
  } catch {
    return null;
  }
}

/** Extract every failed matrix leg from a run so we can dispatch only those. */
async function extractFailingLegs(runId: number): Promise<FailingLeg[]> {
  try {
    const jobs = await ghJson(`/repos/${REPO}/actions/runs/${runId}/jobs?per_page=100&filter=latest`);
    const failed = (jobs?.jobs ?? []).filter((x: any) => x.conclusion === "failure");
    return failed.map((j: any) => {
      const values = (matrixFromJob(j)?.values as string[] | undefined) ?? [];
      // Workflow order is (browser, node). Detect via known browser tokens
      // so we stay robust even if the order changes.
      const browserSet = new Set(["chromium", "firefox", "webkit"]);
      let browser: string | undefined;
      let node: string | undefined;
      for (const v of values) {
        if (browserSet.has(v)) browser = v;
        else if (/^\d+$/.test(v)) node = v;
      }
      return {
        browser,
        node,
        rawJobName: j.name,
        jobUrl: j.html_url,
        jobLogsUrl: j.html_url,
        rawLogsUrl: `https://api.github.com/repos/${REPO}/actions/jobs/${j.id}/logs`,
      } satisfies FailingLeg;
    });
  } catch {
    return [];
  }
}


async function fetchArtifacts(runId: number): Promise<WorkflowArtifact[]> {
  try {
    const data = await ghJson(`/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=50`);
    return (data?.artifacts ?? []).map((a: any) => ({
      id: a.id,
      name: a.name,
      sizeInBytes: a.size_in_bytes,
      expired: !!a.expired,
      htmlUrl: `https://github.com/${REPO}/actions/runs/${runId}/artifacts/${a.id}`,
      apiDownloadUrl: a.archive_download_url,
    }));
  } catch { return []; }
}

function toStatus(
  run: any,
  failingJob: WorkflowRunStatus["failingJob"] = null,
  artifacts: WorkflowArtifact[] = [],
  failingLegs: FailingLeg[] = [],
): WorkflowRunStatus {
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
    artifacts,
    failingLegs,
  };
}

export async function fetchLatestStarterRun(branch?: string): Promise<WorkflowRunStatus | null> {
  if (!isConfigured()) return null;
  try {
    const qs = new URLSearchParams({ per_page: "1" });
    if (branch) qs.set("branch", branch);
    const runs = await ghJson(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?${qs}`);
    const run = runs?.workflow_runs?.[0];
    if (!run) return null;
    const [failing, artifacts, legs] = await Promise.all([
      run.conclusion === "failure" ? extractFailingJob(run.id) : Promise.resolve(null),
      fetchArtifacts(run.id),
      run.conclusion === "failure" ? extractFailingLegs(run.id) : Promise.resolve([]),
    ]);
    return toStatus(run, failing, artifacts, legs);

  } catch {
    return null;
  }
}

export async function fetchLastSuccessfulStarterRun(branch?: string): Promise<WorkflowRunStatus | null> {
  if (!isConfigured()) return null;
  try {
    const qs = new URLSearchParams({ per_page: "1", status: "success" });
    if (branch) qs.set("branch", branch);
    const runs = await ghJson(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?${qs}`);
    const run = runs?.workflow_runs?.[0];
    return run ? toStatus(run, null, []) : null;
  } catch {
    return null;
  }
}

export async function fetchRecentBranches(limit = 50): Promise<string[]> {
  if (!isConfigured()) return [];
  try {
    const runs = await ghJson(
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

/** Trigger workflow_dispatch on the selected branch. Requires a PAT with
 *  `actions:write` (or fine-grained token with Actions: Read & Write) saved
 *  via setStoredToken(). GitHub returns 204 No Content on success and
 *  usually takes 2–8 seconds before the run appears in list APIs. */
export async function dispatchStarterWorkflow(
  branch: string,
  inputs?: Record<string, string>,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!isConfigured()) return { ok: false, status: 0, message: "repo not configured" };
  if (!getStoredToken()) return { ok: false, status: 401, message: "GitHub PAT not saved" };
  try {
    const res = await gh(
      `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: branch, inputs: inputs ?? {} }),
      },
    );
    if (res.status === 204) return { ok: true };
    const body = await res.text();
    return { ok: false, status: res.status, message: body || res.statusText };
  } catch (e: any) {
    return { ok: false, status: 0, message: e?.message ?? "network error" };
  }
}
