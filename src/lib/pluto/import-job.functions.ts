// Admin-only server functions backing the Pluto Migrator panel in the
// Marketplace page: list jobs, re-translate, dry-run, apply.
//
// All return shapes are plain JSON-serializable DTOs (`report` is a JSON
// string) so they cross the server-function boundary safely.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePlutoAdmin } from "./admin-middleware";
import { translateSupabaseSchema, type TranslateWarning } from "./supabase-translate";

export type ImportJobView = {
  id: string;
  event_id: string;
  source: string;
  status: string;
  repo: string | null;
  slug: string | null;
  migration_sql: string | null;
  report: string | null;
  created_at: string;
  updated_at: string;
};

export type SqlOutcome = {
  ok: boolean;
  rowCount: number;
  durationMs: number;
  error: string | null;
  detail: string | null;
};

function toOutcome(res: { ok?: boolean; row_count?: number; duration_ms?: number }): SqlOutcome {
  return {
    ok: res.ok !== false,
    rowCount: typeof res.row_count === "number" ? res.row_count : 0,
    durationMs: typeof res.duration_ms === "number" ? res.duration_ms : 0,
    error: null,
    detail: null,
  };
}

function toFailure(e: unknown): SqlOutcome {
  const err = e as { body?: unknown; message?: string };
  return {
    ok: false,
    rowCount: 0,
    durationMs: 0,
    error: err.message ?? "failed",
    detail: err.body ? JSON.stringify(err.body).slice(0, 4000) : null,
  };
}

export const listImportJobsFn = createServerFn({ method: "GET" })
  .middleware([requirePlutoAdmin])
  .handler(async (): Promise<{ ok: boolean; jobs: ImportJobView[]; error: string | null }> => {
    try {
      const { listImportJobs } = await import("./import-jobs.server");
      const jobs = await listImportJobs(50);
      return {
        ok: true,
        error: null,
        jobs: jobs.map((j) => ({
          id: j.id,
          event_id: j.event_id,
          source: j.source,
          status: j.status,
          repo: j.repo,
          slug: j.slug,
          migration_sql: j.migration_sql,
          report: j.report ? JSON.stringify(j.report).slice(0, 8000) : null,
          created_at: j.created_at,
          updated_at: j.updated_at,
        })),
      };
    } catch (e) {
      return { ok: false, jobs: [], error: (e as Error).message };
    }
  });

const IdInput = z.object({ id: z.string().uuid() });

export const retranslateImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data }): Promise<{
    ok: boolean;
    error: string | null;
    sql: string | null;
    warnings: TranslateWarning[];
    stats: { statements: number; kept: number; dropped: number; rewritten: number } | null;
  }> => {
    const { getImportJobById, updateImportJob } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job) return { ok: false, error: "not_found", sql: null, warnings: [], stats: null };
    const raw = job.payload?.supabase?.schema_sql ?? "";
    if (!raw) return { ok: false, error: "no_schema_sql_in_payload", sql: null, warnings: [], stats: null };
    const t = translateSupabaseSchema(raw);
    await updateImportJob(job.id, {
      status: "translated",
      migration_sql: t.sql,
      report: { translation: t.stats, warnings: t.warnings },
    });
    return { ok: true, error: null, sql: t.sql, warnings: t.warnings, stats: t.stats };
  });

export const dryRunImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data }): Promise<SqlOutcome> => {
    const { getImportJobById, updateImportJob, runImportSql } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job?.migration_sql) {
      return { ok: false, rowCount: 0, durationMs: 0, error: "no_migration_sql", detail: null };
    }
    try {
      const res = await runImportSql(job.migration_sql, true);
      const out = toOutcome(res);
      await updateImportJob(job.id, { status: "dry_run_ok", report: { dry_run: out } });
      return out;
    } catch (e) {
      const out = toFailure(e);
      await updateImportJob(job.id, { status: "dry_run_failed", report: { dry_run: out } });
      return out;
    }
  });

export const applyImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.extend({ confirm: z.literal(true) }).parse(d))
  .handler(async ({ data }): Promise<SqlOutcome> => {
    const { getImportJobById, updateImportJob, runImportSql } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job?.migration_sql) {
      return { ok: false, rowCount: 0, durationMs: 0, error: "no_migration_sql", detail: null };
    }
    try {
      const res = await runImportSql(job.migration_sql, false);
      const out = toOutcome(res);
      await updateImportJob(job.id, {
        status: "applied",
        report: { applied: out, applied_at: new Date().toISOString() },
      });
      return out;
    } catch (e) {
      const out = toFailure(e);
      await updateImportJob(job.id, { status: "apply_failed", report: { apply: out } });
      return out;
    }
  });

/** Repo pointer for handing the job over to Auto-Deploy Studio. */
export const importJobRepoInfo = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data }): Promise<{ ok: boolean; repo: string | null; ref: string | null; zipball_url: string | null; hint: string }> => {
    const { getImportJobById } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job) return { ok: false, repo: null, ref: null, zipball_url: null, hint: "Job not found." };
    return {
      ok: true,
      repo: job.repo ?? null,
      ref: job.payload?.ref ?? null,
      zipball_url: job.payload?.zipball_url ?? null,
      hint: job.repo
        ? "Open Auto-Deploy Studio and paste this repo URL to build + serve the frontend."
        : "This job carried no repository — it is a database-only import.",
    };
  });
