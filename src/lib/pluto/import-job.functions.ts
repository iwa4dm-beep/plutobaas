// Admin-only server functions backing the Pluto Migrator panel in the
// Marketplace page: list jobs, inspect the dump, re-translate with a
// schema/table selection, dry-run, apply — every step audited.
//
// All return shapes are plain JSON-serializable DTOs (`report` is a JSON
// string) so they cross the server-function boundary safely.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePlutoAdmin } from "./admin-middleware";
import { translateSupabaseSchema, type TranslateWarning } from "./supabase-translate";
import { filterDumpBySelection, inventoryDump, type DumpObject } from "./supabase-objects";
import { diffSql, type SqlDiff } from "./sql-diff";

export type ImportJobView = {
  id: string;
  event_id: string;
  source: string;
  status: string;
  repo: string | null;
  slug: string | null;
  migration_sql: string | null;
  report: string | null;
  applied_at: string | null;
  applied_by: string | null;
  selection: string[] | null;
  paused: boolean;
  paused_by: string | null;
  paused_at: string | null;
  resume_step: string | null;
  created_at: string;
  updated_at: string;
};

export type SqlVersionView = {
  id: string;
  version: number;
  kind: string;
  counts: Record<string, number> | null;
  destructive_count: number | null;
  actor_email: string | null;
  note: string | null;
  selection: string[] | null;
  sql_length: number;
  created_at: string;
};


export type ImportEventView = {
  id: string;
  job_id: string;
  step: string;
  ok: boolean;
  actor_email: string | null;
  row_count: number | null;
  duration_ms: number | null;
  message: string | null;
  detail: string | null;
  created_at: string;
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

type JobRow = {
  id: string;
  event_id: string;
  source: string;
  status: string;
  repo: string | null;
  slug: string | null;
  migration_sql: string | null;
  report: Record<string, unknown> | null;
  applied_at: string | null;
  applied_by: string | null;
  selection: string[] | null;
  paused: boolean;
  paused_by: string | null;
  paused_at: string | null;
  resume_step: string | null;
  created_at: string;
  updated_at: string;
};

function toJobView(j: JobRow): ImportJobView {
  return {
    id: j.id,
    event_id: j.event_id,
    source: j.source,
    status: j.status,
    repo: j.repo,
    slug: j.slug,
    migration_sql: j.migration_sql,
    report: j.report ? JSON.stringify(j.report).slice(0, 8000) : null,
    applied_at: j.applied_at,
    applied_by: j.applied_by,
    selection: j.selection,
    paused: j.paused === true,
    paused_by: j.paused_by,
    paused_at: j.paused_at,
    resume_step: j.resume_step,
    created_at: j.created_at,
    updated_at: j.updated_at,
  };
}

export const listImportJobsFn = createServerFn({ method: "GET" })
  .middleware([requirePlutoAdmin])
  .handler(async (): Promise<{ ok: boolean; jobs: ImportJobView[]; error: string | null }> => {
    try {
      const { listImportJobs } = await import("./import-jobs.server");
      const jobs = await listImportJobs(50);
      return { ok: true, error: null, jobs: jobs.map(toJobView) };
    } catch (e) {
      return { ok: false, jobs: [], error: (e as Error).message };
    }
  });

const IdInput = z.object({ id: z.string().uuid() });

/** Full audit history — for one job, or the whole account when `id` is null. */
export const importAuditHistoryFn = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid().nullish(), limit: z.number().int().min(1).max(500).optional() }).parse(d ?? {}),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; events: ImportEventView[]; error: string | null }> => {
    try {
      const { listImportEvents } = await import("./import-jobs.server");
      const events = await listImportEvents(data.id ?? null, data.limit ?? 200);
      return {
        ok: true,
        error: null,
        events: events.map((e) => ({
          id: e.id,
          job_id: e.job_id,
          step: e.step,
          ok: e.ok,
          actor_email: e.actor_email,
          row_count: e.row_count,
          duration_ms: e.duration_ms,
          message: e.message,
          detail: e.detail ? JSON.stringify(e.detail).slice(0, 6000) : null,
          created_at: e.created_at,
        })),
      };
    } catch (e) {
      return { ok: false, events: [], error: (e as Error).message };
    }
  });

/** Inventory of the raw dump + diff of the currently generated migration. */
export const importJobPlanFn = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data }): Promise<{
    ok: boolean;
    error: string | null;
    objects: DumpObject[];
    selection: string[] | null;
    diff: SqlDiff | null;
    hasDump: boolean;
  }> => {
    const { getImportJobById } = await import("./import-jobs.server");
    const job = await getImportJobById(data.id);
    if (!job) return { ok: false, error: "not_found", objects: [], selection: null, diff: null, hasDump: false };
    const raw = job.payload?.supabase?.schema_sql ?? "";
    return {
      ok: true,
      error: null,
      objects: raw ? inventoryDump(raw) : [],
      selection: job.selection,
      diff: job.migration_sql ? diffSql(job.migration_sql) : null,
      hasDump: Boolean(raw),
    };
  });

/** Re-translate, optionally restricted to a selected set of dump objects. */
export const retranslateImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) =>
    IdInput.extend({ selection: z.array(z.string().max(300)).max(2000).optional() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{
    ok: boolean;
    error: string | null;
    sql: string | null;
    warnings: TranslateWarning[];
    stats: { statements: number; kept: number; dropped: number; rewritten: number } | null;
    diff: SqlDiff | null;
  }> => {
    const { getImportJobById, updateImportJob, appendImportEvent, saveSelection } = await import("./import-jobs.server");
    const actor = context.plutoAdmin;
    const job = await getImportJobById(data.id);
    if (!job) return { ok: false, error: "not_found", sql: null, warnings: [], stats: null, diff: null };
    const raw = job.payload?.supabase?.schema_sql ?? "";
    if (!raw) return { ok: false, error: "no_schema_sql_in_payload", sql: null, warnings: [], stats: null, diff: null };

    const selection = data.selection ?? job.selection ?? [];
    const scoped = selection.length ? filterDumpBySelection(raw, selection) : raw;
    const t = translateSupabaseSchema(scoped);
    const diff = diffSql(t.sql);

    if (data.selection) {
      await saveSelection(job.id, data.selection);
      await appendImportEvent({
        jobId: job.id,
        step: "selection_changed",
        actorId: actor.userId,
        actorEmail: actor.email,
        message: `Selected ${data.selection.length} object(s) from the dump`,
        detail: { selection: data.selection.slice(0, 200) },
      });
    }

    await updateImportJob(job.id, {
      status: "translated",
      migration_sql: t.sql,
      report: { translation: t.stats, warnings: t.warnings },
    });
    await appendImportEvent({
      jobId: job.id,
      step: "translated",
      actorId: actor.userId,
      actorEmail: actor.email,
      message: `${t.stats.kept} statements kept, ${t.stats.dropped} dropped, ${t.stats.rewritten} rewritten`,
      detail: { stats: t.stats, counts: diff.counts, destructive: diff.destructiveCount },
    });

    return { ok: true, error: null, sql: t.sql, warnings: t.warnings, stats: t.stats, diff };
  });

export const dryRunImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.parse(d))
  .handler(async ({ data, context }): Promise<SqlOutcome> => {
    const { getImportJobById, updateImportJob, runImportSql, appendImportEvent } = await import("./import-jobs.server");
    const actor = context.plutoAdmin;
    const job = await getImportJobById(data.id);
    if (!job?.migration_sql) {
      return { ok: false, rowCount: 0, durationMs: 0, error: "no_migration_sql", detail: null };
    }
    const diff = diffSql(job.migration_sql);
    try {
      const res = await runImportSql(job.migration_sql, true);
      const out = toOutcome(res);
      await updateImportJob(job.id, { status: "dry_run_ok", report: { dry_run: out, diff: diff.counts } });
      await appendImportEvent({
        jobId: job.id,
        step: "dry_run",
        ok: true,
        actorId: actor.userId,
        actorEmail: actor.email,
        rowCount: out.rowCount,
        durationMs: out.durationMs,
        message: `Dry-run OK — ${diff.counts.create} create / ${diff.counts.alter} alter / ${diff.counts.drop} drop`,
        detail: { diff: diff.counts, destructive: diff.destructiveCount },
      });
      return out;
    } catch (e) {
      const out = toFailure(e);
      await updateImportJob(job.id, { status: "dry_run_failed", report: { dry_run: out } });
      await appendImportEvent({
        jobId: job.id,
        step: "dry_run",
        ok: false,
        actorId: actor.userId,
        actorEmail: actor.email,
        message: out.error,
        detail: { error: out.error, detail: out.detail },
      });
      return out;
    }
  });

export const applyImportJob = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => IdInput.extend({ confirm: z.literal(true) }).parse(d))
  .handler(async ({ data, context }): Promise<SqlOutcome> => {
    const { getImportJobById, updateImportJob, runImportSql, appendImportEvent, markApplied } =
      await import("./import-jobs.server");
    const actor = context.plutoAdmin;
    const job = await getImportJobById(data.id);
    if (!job?.migration_sql) {
      return { ok: false, rowCount: 0, durationMs: 0, error: "no_migration_sql", detail: null };
    }
    const diff = diffSql(job.migration_sql);
    try {
      const res = await runImportSql(job.migration_sql, false);
      const out = toOutcome(res);
      await updateImportJob(job.id, {
        status: "applied",
        report: { applied: out, applied_at: new Date().toISOString(), diff: diff.counts },
      });
      await markApplied(job.id, actor.email);
      await appendImportEvent({
        jobId: job.id,
        step: "apply",
        ok: true,
        actorId: actor.userId,
        actorEmail: actor.email,
        rowCount: out.rowCount,
        durationMs: out.durationMs,
        message: `Applied — ${diff.counts.create} create / ${diff.counts.alter} alter / ${diff.counts.drop} drop`,
        detail: { diff: diff.counts, repo: job.repo, source: job.source, selection: job.selection },
      });
      return out;
    } catch (e) {
      const out = toFailure(e);
      await updateImportJob(job.id, { status: "apply_failed", report: { apply: out } });
      await appendImportEvent({
        jobId: job.id,
        step: "apply",
        ok: false,
        actorId: actor.userId,
        actorEmail: actor.email,
        message: out.error,
        detail: { error: out.error, detail: out.detail },
      });
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
