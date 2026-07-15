import { createServerFn } from "@tanstack/react-start";

// Fetches GitHub Actions status for the configured repo through the Lovable
// connector gateway. Returns a normalized list of workflow runs the
// /dashboard/ci-status page renders.
//
// Env vars:
//   LOVABLE_API_KEY, GITHUB_API_KEY  — injected by the GitHub connector.
//   GITHUB_REPO_OWNER, GITHUB_REPO_NAME — optional defaults. Users can also
//     pass owner/repo via input to override.

const GATEWAY_URL = "https://connector-gateway.lovable.dev/github";

export type WorkflowRunSummary = {
  id: number;
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | skipped | null
  head_branch: string | null;
  head_sha: string;
  event: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_number: number;
  pull_requests: Array<{ number: number; url: string }>;
};

export type CiStatusResponse = {
  ok: boolean;
  owner: string;
  repo: string;
  runs: WorkflowRunSummary[];
  error?: string;
};

export const getCiStatus = createServerFn({ method: "GET" })
  .inputValidator((data: { owner?: string; repo?: string; workflow?: string; perPage?: number }) => data ?? {})
  .handler(async ({ data }): Promise<CiStatusResponse> => {
    const owner = data.owner || process.env.GITHUB_REPO_OWNER || "";
    const repo = data.repo || process.env.GITHUB_REPO_NAME || "";
    const perPage = Math.min(Math.max(data.perPage ?? 25, 1), 100);
    const lovableKey = process.env.LOVABLE_API_KEY;
    const gitHubKey = process.env.GITHUB_API_KEY;

    if (!lovableKey || !gitHubKey) {
      return { ok: false, owner, repo, runs: [], error: "GitHub connector not configured (missing LOVABLE_API_KEY or GITHUB_API_KEY)." };
    }
    if (!owner || !repo) {
      return { ok: false, owner, repo, runs: [], error: "Missing owner/repo. Provide them via query params or set GITHUB_REPO_OWNER / GITHUB_REPO_NAME secrets." };
    }

    const path = data.workflow
      ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(data.workflow)}/runs`
      : `/repos/${owner}/${repo}/actions/runs`;
    const url = `${GATEWAY_URL}${path}?per_page=${perPage}`;

    try {
      const resp = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": gitHubKey,
        },
      });
      if (!resp.ok) {
        const body = await resp.text();
        return { ok: false, owner, repo, runs: [], error: `GitHub API ${resp.status}: ${body.slice(0, 400)}` };
      }
      const json: any = await resp.json();
      const runs: WorkflowRunSummary[] = (json.workflow_runs ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        head_branch: r.head_branch,
        head_sha: r.head_sha,
        event: r.event,
        html_url: r.html_url,
        created_at: r.created_at,
        updated_at: r.updated_at,
        run_number: r.run_number,
        pull_requests: (r.pull_requests ?? []).map((p: any) => ({ number: p.number, url: p.url })),
      }));
      return { ok: true, owner, repo, runs };
    } catch (e: any) {
      return { ok: false, owner, repo, runs: [], error: e?.message ?? "unknown error" };
    }
  });

export type PublishStatus = {
  previewUrl: string;
  publishedUrl: string;
  customDomains: string[];
};

export const getPublishStatus = createServerFn({ method: "GET" }).handler(async (): Promise<PublishStatus> => {
  // Static — Lovable-managed publish URLs are project-level and stable.
  // Custom domains are configured in Project Settings → Domains and echoed
  // here via optional PLUTO_CUSTOM_DOMAINS (comma-separated) secret.
  const domains = (process.env.PLUTO_CUSTOM_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return {
    previewUrl: "https://id-preview--a121327a-6c20-4978-80f0-5e01b27a5e18.lovable.app",
    publishedUrl: "https://plutobaas.lovable.app",
    customDomains: domains,
  };
});
