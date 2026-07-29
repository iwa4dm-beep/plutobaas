// Pre-apply snapshot + rollback plan generator.
//
// Before an import job's SQL is executed we:
//   1. inventory the objects that already exist in the target database
//      (tables / views / functions / policies) so an operator can tell
//      afterwards what the migration actually added,
//   2. derive the inverse ("undo") script from the SQL about to run, and
//   3. archive both as a `rollback_plan` version tied to the same import_job.
//
// The archive is what the one-click rollback executes later, so the plan
// exists even if the apply crashes half-way through.
import { buildRollbackPlan } from "./sql-rollback";

export type PreApplySnapshot = {
  ok: boolean;
  version: number | null;
  existing: { tables: string[]; views: string[]; functions: string[]; policies: number };
  plan: { statements: number; unsupported: number };
  error: string | null;
};

const SNAPSHOT_SQL = `
  select
    coalesce((select json_agg(t) from (
      select table_schema || '.' || table_name as t
      from information_schema.tables
      where table_schema not in ('pg_catalog','information_schema') and table_type = 'BASE TABLE'
      order by 1 limit 2000) s), '[]'::json) as tables,
    coalesce((select json_agg(v) from (
      select table_schema || '.' || table_name as v
      from information_schema.views
      where table_schema not in ('pg_catalog','information_schema')
      order by 1 limit 2000) s), '[]'::json) as views,
    coalesce((select json_agg(f) from (
      select n.nspname || '.' || p.proname as f
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog','information_schema')
      order by 1 limit 2000) s), '[]'::json) as functions,
    (select count(*) from pg_policies) as policies
`;

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).slice(0, 2000);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Capture the pre-apply state and archive the rollback plan for `jobId`.
 * Never throws — a failed snapshot must not block the apply itself.
 */
export async function capturePreApplySnapshot(input: {
  jobId: string;
  sql: string;
  actorId?: string | null;
  actorEmail?: string | null;
}): Promise<PreApplySnapshot> {
  const { readQuery, saveSqlVersion, appendImportEvent } = await import("./import-jobs.server");
  const plan = buildRollbackPlan(input.sql);
  const empty = { tables: [] as string[], views: [] as string[], functions: [] as string[], policies: 0 };
  let existing = empty;

  try {
    const res = await readQuery(SNAPSHOT_SQL);
    const row = ((res.rows ?? []) as Record<string, unknown>[])[0];
    if (row) {
      existing = {
        tables: asList(row.tables),
        views: asList(row.views),
        functions: asList(row.functions),
        policies: Number(row.policies ?? 0),
      };
    }
  } catch (e) {
    await appendImportEvent({
      jobId: input.jobId,
      step: "snapshot",
      ok: false,
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      message: `Pre-apply snapshot failed: ${(e as Error).message}`,
    }).catch(() => {});
  }

  try {
    const version = await saveSqlVersion({
      jobId: input.jobId,
      kind: "rollback_plan",
      sql: plan.sql || "-- nothing invertible in this migration\n",
      counts: {
        statements: plan.entries.length,
        unsupported: plan.unsupported.length,
        existing_tables: existing.tables.length,
        existing_views: existing.views.length,
      },
      actorEmail: input.actorEmail ?? null,
      note: "Pre-apply snapshot + generated rollback plan",
    });
    await appendImportEvent({
      jobId: input.jobId,
      step: "snapshot",
      ok: true,
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      message:
        `Pre-apply snapshot: ${existing.tables.length} table(s), ${existing.views.length} view(s), ` +
        `${existing.policies} policy/policies — rollback plan with ${plan.entries.length} statement(s)`,
      detail: {
        existing_tables: existing.tables.slice(0, 200),
        existing_views: existing.views.slice(0, 200),
        policies: existing.policies,
        rollback_statements: plan.entries.length,
        rollback_unsupported: plan.unsupported.length,
        version: version?.version ?? null,
      },
    }).catch(() => {});
    return {
      ok: true,
      version: version?.version ?? null,
      existing,
      plan: { statements: plan.entries.length, unsupported: plan.unsupported.length },
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      version: null,
      existing,
      plan: { statements: plan.entries.length, unsupported: plan.unsupported.length },
      error: (e as Error).message,
    };
  }
}
