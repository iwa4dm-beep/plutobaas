// Headless rollback executor shared by the dashboard server function and the
// HMAC-signed extension endpoint. Uses the archived `rollback_plan` snapshot
// taken before apply, falling back to inverting the applied SQL.
import { buildRollbackPlan } from "./sql-rollback";

export type HeadlessRollback = {
  ok: boolean;
  error: string | null;
  sourceVersion: number | null;
  statements: number;
  unsupported: number;
  dryRun: boolean;
  rowCount: number;
  durationMs: number;
  sql: string | null;
};

export async function runJobRollback(input: {
  jobId: string;
  dryRun: boolean;
  actorId?: string | null;
  actorEmail?: string | null;
}): Promise<HeadlessRollback> {
  const { getImportJobById, listSqlVersions, runImportSql, updateImportJob, appendImportEvent } =
    await import("./import-jobs.server");
  const base: HeadlessRollback = {
    ok: false, error: null, sourceVersion: null, statements: 0,
    unsupported: 0, dryRun: input.dryRun, rowCount: 0, durationMs: 0, sql: null,
  };
  const job = await getImportJobById(input.jobId);
  if (!job) return { ...base, error: "job_not_found" };

  const versions = await listSqlVersions(job.id, 100);
  const planned = versions.find((v) => v.kind === "rollback_plan");
  const applied = versions.find((v) => v.kind === "apply");
  const sourceSql = planned?.sql ?? applied?.sql ?? job.migration_sql;
  if (!sourceSql) return { ...base, error: "no_applied_sql" };

  const plan = planned ? { sql: planned.sql, entries: [], unsupported: [] } : buildRollbackPlan(sourceSql);
  const rollbackSql = planned ? planned.sql : plan.sql;
  const derived = planned ? buildRollbackPlan(applied?.sql ?? job.migration_sql ?? "") : plan;
  if (!rollbackSql.trim()) return { ...base, error: "nothing_to_roll_back" };

  const started = Date.now();
  try {
    const res = await runImportSql(rollbackSql, input.dryRun);
    const durationMs = Date.now() - started;
    if (!input.dryRun) {
      await updateImportJob(job.id, {
        status: "rolled_back",
        report: { rollback: { rowCount: res.row_count ?? 0, durationMs }, rolled_back_at: new Date().toISOString() },
      });
    }
    await appendImportEvent({
      jobId: job.id,
      step: "rollback",
      ok: true,
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      durationMs,
      message: `${input.dryRun ? "Rollback dry-run" : "Rollback"} OK from ${planned ? `snapshot v${planned.version}` : "applied SQL"}`,
      detail: { source_version: planned?.version ?? applied?.version ?? null, statements: derived.entries.length },
    }).catch(() => {});
    return {
      ...base,
      ok: true,
      sourceVersion: planned?.version ?? applied?.version ?? null,
      statements: derived.entries.length,
      unsupported: derived.unsupported.length,
      rowCount: Number(res.row_count ?? 0),
      durationMs,
      sql: rollbackSql,
    };
  } catch (e) {
    const message = (e as Error).message;
    if (!input.dryRun) await updateImportJob(job.id, { status: "rollback_failed", report: { rollback: { error: message } } });
    await appendImportEvent({
      jobId: job.id,
      step: "rollback",
      ok: false,
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      message,
    }).catch(() => {});
    return { ...base, error: message, sql: rollbackSql, durationMs: Date.now() - started };
  }
}
