// Admin-only server functions backing the Pluto Migrator panel in the
// Marketplace page: list jobs, re-translate, dry-run, apply, rollback.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePlutoAdmin } from "./admin-middleware";
import { translateSupabaseSchema } from "./supabase-translate";

export type ImportJobView = {
  id: string;
  event_id: string;
  source: string;
  status: string;
  repo: string | null;
  slug: string | null;
  migration_sql: string | null;
  report: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export const listImportJobsFn = createServerFn({ method: "GET" })
  .middleware([requirePlutoAdmin])
  .handler(async (): Promise<{ ok: boolean; jobs: ImportJobView[]; error?: string }> => {
    try {
      const { listImportJobs } = await import("./import-jobs.server");
      const jobs = await listImportJobs(50);
      return { ok: true, jobs: jobs.map((j) => ({ ...j, payload: undefined }) as unknown as ImportJobView) };
    } catch (e) {
      return { ok: false, jobs: [], error: (e as Error).message };
    }
  });

const IdInput = z.object({ id: z.string().uuid() });

export const retranslateImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data }) => {
    const { getImportJobById, updateImportJob } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job) return { ok: false, error: "not_found" };
    const raw = job.payload?.supabase?.schema_sql ?? "";
    if (!raw) return { ok: false, error: "no_schema_sql_in_payload" };
    const t = translateSupabaseSchema(raw);
    await updateImportJob(job.id, { status: "translated", migration_sql: t.sql, report: { translation: t.stats, warnings: t.warnings } });
    return { ok: true, stats: t.stats, warnings: t.warnings, sql: t.sql };
  });

export const dryRunImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data }) => {
    const { getImportJobById, updateImportJob, runImportSql } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job?.migration_sql) return { ok: false, error: "no_migration_sql" };
    try {
      const res = await runImportSql(job.migration_sql, true);
      await updateImportJob(job.id, { status: "dry_run_ok", report: { dry_run: res } });
      return { ok: true, result: res };
    } catch (e) {
      const err = e as { status?: number; body?: unknown; message?: string };
      await updateImportJob(job.id, { status: "dry_run_failed", report: { dry_run_error: err.body ?? err.message } });
      return { ok: false, error: err.message ?? "dry_run_failed", body: err.body };
    }
  });

export const applyImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.extend({ confirm: z.literal(true) }).parse(d))
  .handler(async ({ data }) => {
    const { getImportJobById, updateImportJob, runImportSql } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job?.migration_sql) return { ok: false, error: "no_migration_sql" };
    try {
      const res = await runImportSql(job.migration_sql, false);
      await updateImportJob(job.id, { status: "applied", report: { applied: res, applied_at: new Date().toISOString() } });
      return { ok: true, result: res };
    } catch (e) {
      const err = e as { status?: number; body?: unknown; message?: string };
      await updateImportJob(job.id, { status: "apply_failed", report: { apply_error: err.body ?? err.message } });
      return { ok: false, error: err.message ?? "apply_failed", body: err.body };
    }
  });

/** Deploy the job's GitHub repo through the existing sandbox-worker pipeline. */
export const importJobRepoInfo = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data }) => {
    const { getImportJobById } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job) return { ok: false, error: "not_found" };
    return {
      ok: true,
      repo: job.repo,
      ref: job.payload?.ref ?? null,
      zipball_url: job.payload?.zipball_url ?? null,
      hint: job.repo
        ? "Open Auto-Deploy Studio and paste this repo URL to build + serve the frontend."
        : "This job carried no repository — it is a database-only import.",
    };
  });
