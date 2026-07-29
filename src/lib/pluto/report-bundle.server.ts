// Server-only builder for the import job report bundle. Shared by the
// admin server function and the signed public share-link endpoint.
import { diffSql } from "./sql-diff";
import type { SmokeReport } from "./smoke-types";
import type { VerificationDiff } from "./verification-diff";
import type { ImportReportBundle, VerificationRunView } from "./report-types";
import type { SqlVersionView } from "./import-job.functions";

export async function buildReportBundle(
  jobId: string,
  includeSql: boolean,
  generatedBy: string | null,
  shared?: { expiresAt: string; createdBy: string | null } | null,
): Promise<ImportReportBundle | null> {
  const { getImportJobById, listImportEvents, listSqlVersions, getSqlVersion, listVerificationRuns } = await import(
    "./import-jobs.server"
  );
  const job = await getImportJobById(jobId);
  if (!job) return null;

  const [events, versionRows, runs] = await Promise.all([
    listImportEvents(job.id, 500),
    listSqlVersions(job.id, 50),
    listVerificationRuns(job.id, 25),
  ]);

  const versions = await Promise.all(
    versionRows.map(async (v) => {
      const base: SqlVersionView & { sql?: string } = {
        id: v.id,
        version: v.version,
        kind: v.kind,
        counts: v.counts,
        destructive_count: v.destructive_count,
        actor_email: v.actor_email,
        note: v.note,
        selection: v.selection,
        sql_length: v.sql?.length ?? 0,
        created_at: v.created_at,
      };
      if (includeSql) {
        const full = await getSqlVersion(job.id, v.version);
        base.sql = full?.sql ?? undefined;
      }
      return base;
    }),
  );

  const report = (job.report ?? {}) as Record<string, unknown>;
  const verificationRuns: VerificationRunView[] = runs.map((r) => ({
    run_no: r.run_no,
    ok: r.ok,
    trigger: r.trigger,
    actor_email: r.actor_email,
    created_at: r.created_at,
    report: r.report as unknown as SmokeReport,
    diff: (r.diff as unknown as VerificationDiff | null) ?? null,
  }));
  const verification =
    verificationRuns[0]?.report ?? ((report.verification as SmokeReport | undefined) ?? null);

  return {
    generatedAt: new Date().toISOString(),
    generatedBy,
    shared: shared ?? null,
    job: {
      id: job.id,
      event_id: job.event_id,
      source: job.source,
      status: job.status,
      repo: job.repo,
      slug: job.slug,
      migration_sql: null,
      report: JSON.stringify(report),
      applied_at: job.applied_at,
      applied_by: job.applied_by,
      selection: job.selection,
      paused: job.paused,
      paused_by: job.paused_by,
      paused_at: job.paused_at,
      resume_step: job.resume_step,
      created_at: job.created_at,
      updated_at: job.updated_at,
    },
    diff: job.migration_sql ? diffSql(job.migration_sql) : null,
    verification,
    verificationRuns,
    versions,
    events: events.map((e) => ({
      id: e.id,
      job_id: e.job_id,
      step: e.step,
      ok: e.ok,
      actor_email: e.actor_email,
      row_count: e.row_count,
      duration_ms: e.duration_ms,
      message: e.message,
      detail: e.detail ? JSON.stringify(e.detail) : null,
      created_at: e.created_at,
    })),
    failures: events
      .filter((e) => !e.ok)
      .map((e) => ({
        step: e.step,
        created_at: e.created_at,
        message: e.message,
        detail: e.detail ? JSON.stringify(e.detail) : null,
      })),
    migrationSql: includeSql ? job.migration_sql : null,
  };
}
