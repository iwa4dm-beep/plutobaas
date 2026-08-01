/**
 * Baseline schema apply — shared by /dashboard/database-import and the
 * Go-Live auto-runner's self-healing step.
 *
 * Pushes CONSOLIDATED_SCHEMA_SQL through the dbio schema-import job and polls
 * the job until it settles, so callers can await a real outcome instead of
 * just "started".
 */

import { CONSOLIDATED_SCHEMA_SQL } from "./connect-schema";
import { getUpstream } from "./upstream";

export type BaselineApplyResult = {
  ok: boolean;
  jobId?: string;
  status?: string;
  detail: string;
};

type Job = { id?: string; status?: string; error?: string | null; message?: string };

/** Failure signatures that mean "baseline tables are missing", not a config bug. */
export function looksLikeMissingBaseline(text: string | undefined | null): boolean {
  if (!text) return false;
  return /42p01|relation .* does not exist|undefined_table|could not find the table|public\.todos/i.test(
    text,
  );
}

export async function applyBaselineSchema(opts: {
  /** Override the API base (defaults to the stored upstream / same-origin proxy). */
  apiBase?: string;
  /** Max time to wait for the import job to settle. */
  timeoutMs?: number;
  onLog?: (message: string) => void;
} = {}): Promise<BaselineApplyResult> {
  const { url, token } = getUpstream();
  const base = (opts.apiBase || url || "/api/pluto").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const log = (m: string) => opts.onLog?.(m);

  try {
    const fd = new FormData();
    fd.append(
      "file",
      new File([CONSOLIDATED_SCHEMA_SQL], "pluto-baseline.sql", { type: "application/sql" }),
    );
    log(`Uploading baseline schema to ${base}/admin/v1/dbio/import/schema`);
    const res = await fetch(`${base}/admin/v1/dbio/import/schema?schema=public`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = (await res.json().catch(() => ({}))) as { job_id?: string; error?: string; message?: string };
    if (!res.ok || !body.job_id) {
      const detail = body.error ?? body.message ?? `HTTP ${res.status}`;
      log(`Baseline apply rejected: ${detail}`);
      return { ok: false, detail };
    }
    const jobId = body.job_id;
    log(`Baseline job ${jobId} started — polling…`);

    const deadline = Date.now() + timeoutMs;
    let status = "pending";
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const jr = await fetch(`${base}/admin/v1/dbio/jobs/${jobId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const job = (await jr.json().catch(() => ({}))) as Job;
      status = job.status ?? status;
      lastError = job.error ?? null;
      if (status !== "running" && status !== "pending") break;
    }

    const ok = status === "succeeded" || status === "success" || status === "completed" || status === "done";
    const detail = ok
      ? `Baseline schema applied (job ${jobId}).`
      : `Baseline job ${jobId} ended as "${status}"${lastError ? `: ${lastError}` : ""}.`;
    log(detail);
    return { ok, jobId, status, detail };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log(`Baseline apply error: ${detail}`);
    return { ok: false, detail };
  }
}
