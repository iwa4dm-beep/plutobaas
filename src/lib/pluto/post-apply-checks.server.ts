// Post-apply smoke tests / integrity checks.
//
// After a migration is applied we verify that the objects the admin actually
// selected exist, are readable, and are not left in a broken state (invalid
// indexes, NOT VALID constraints, RLS-enabled tables with zero policies).
// Results are recorded on the job timeline + audit history.
//
// Server-only: every query here is read-only and runs through the service-role
// SQL surface.
import { readQuery } from "./import-jobs.server";
import { splitSqlStatements } from "./supabase-translate";

export type CheckStatus = "pass" | "warn" | "fail";

export type SmokeCheck = {
  /** Stable id, e.g. `exists:public.notes`. */
  id: string;
  /** Human label shown in the timeline / report. */
  label: string;
  /** `public.notes`, or `—` for database-wide checks. */
  target: string;
  status: CheckStatus;
  detail: string;
  rowCount: number | null;
};

export type SmokeReport = {
  ok: boolean;
  ranAt: string;
  durationMs: number;
  targets: string[];
  counts: { pass: number; warn: number; fail: number };
  checks: SmokeCheck[];
};

type Row = Record<string, unknown>;

function rows(res: { rows?: unknown[] } | null | undefined): Row[] {
  return (res?.rows ?? []) as Row[];
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function unquote(part: string): string {
  const p = part.trim();
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

/** `public.notes` / `"public"."notes"` / `notes` → `{schema, name}`. */
export function parseQualified(key: string): { schema: string; name: string } {
  const cleaned = key.replace(/^(table|view|function|schema):/i, "").trim();
  const parts = cleaned.split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (parts.length >= 2) return { schema: unquote(parts[0]), name: unquote(parts.slice(1).join(".")) };
  return { schema: "public", name: unquote(cleaned) };
}

/**
 * Work out which relations to verify: the admin's object selection when set,
 * otherwise every relation created by the applied SQL.
 */
export function deriveTargets(selection: string[] | null, appliedSql: string | null): string[] {
  const out = new Set<string>();
  for (const key of selection ?? []) {
    if (/^schema:/i.test(key)) continue; // schema-level entries have no relation to probe
    const { schema, name } = parseQualified(key);
    if (name) out.add(`${schema}.${name}`);
  }
  if (out.size) return [...out];

  for (const stmt of splitSqlStatements(appliedSql ?? "")) {
    const m = /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(table|view)\s+(?:if\s+not\s+exists\s+)?("?[\w$]+"?(?:\s*\.\s*"?[\w$]+"?)?)/i.exec(stmt);
    if (m) {
      const { schema, name } = parseQualified(m[2].replace(/\s+/g, ""));
      out.add(`${schema}.${name}`);
    }
  }
  return [...out];
}

async function safeRead(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; error: string | null }> {
  try {
    const res = await readQuery(sql, params);
    return { rows: rows(res), error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Run the full integrity suite for a job's targets. */
export async function runSmokeChecks(
  selection: string[] | null,
  appliedSql: string | null,
): Promise<SmokeReport> {
  const started = Date.now();
  const targets = deriveTargets(selection, appliedSql).slice(0, 60);
  const checks: SmokeCheck[] = [];

  for (const target of targets) {
    const { schema, name } = parseQualified(target);

    // 1. Does the relation exist, and what kind is it?
    const rel = await safeRead(
      `select c.relkind::text as kind, c.relrowsecurity as rls
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = $2`,
      [schema, name],
    );
    if (rel.error) {
      checks.push({ id: `exists:${target}`, label: "Object exists", target, status: "fail", detail: rel.error, rowCount: null });
      continue;
    }
    if (!rel.rows.length) {
      checks.push({ id: `exists:${target}`, label: "Object exists", target, status: "fail", detail: "Relation not found after apply", rowCount: null });
      continue;
    }
    const kind = String(rel.rows[0].kind ?? "");
    const rlsOn = rel.rows[0].rls === true || rel.rows[0].rls === "t";
    checks.push({
      id: `exists:${target}`,
      label: "Object exists",
      target,
      status: "pass",
      detail: kind === "r" ? "table" : kind === "v" ? "view" : kind === "m" ? "materialized view" : `relkind ${kind}`,
      rowCount: null,
    });

    // 2. Is it actually readable (catches broken views and bad column refs)?
    const probe = await safeRead(`select count(*)::bigint as n from "${schema}"."${name}"`);
    if (probe.error) {
      checks.push({ id: `readable:${target}`, label: "Readable", target, status: "fail", detail: probe.error, rowCount: null });
    } else {
      const n = num(probe.rows[0]?.n);
      checks.push({ id: `readable:${target}`, label: "Row count", target, status: "pass", detail: `${n ?? 0} row(s)`, rowCount: n });
    }

    if (kind !== "r") continue;

    // 3. RLS enabled but no policies = table is unreachable for app users.
    const pol = await safeRead(
      `select count(*)::int as n from pg_policies where schemaname = $1 and tablename = $2`,
      [schema, name],
    );
    const policies = num(pol.rows[0]?.n) ?? 0;
    checks.push({
      id: `rls:${target}`,
      label: "RLS / policies",
      target,
      status: rlsOn && policies === 0 ? "warn" : "pass",
      detail: rlsOn
        ? policies === 0
          ? "RLS enabled with 0 policies — no client can read this table"
          : `RLS enabled · ${policies} policy(ies)`
        : `RLS disabled${policies ? ` · ${policies} policy(ies)` : ""}`,
      rowCount: policies,
    });

    // 4. Primary key present (imports that lost a PK break upserts/realtime).
    const pk = await safeRead(
      `select count(*)::int as n from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace nsp on nsp.oid = c.relnamespace
        where con.contype = 'p' and nsp.nspname = $1 and c.relname = $2`,
      [schema, name],
    );
    const hasPk = (num(pk.rows[0]?.n) ?? 0) > 0;
    checks.push({
      id: `pk:${target}`,
      label: "Primary key",
      target,
      status: hasPk ? "pass" : "warn",
      detail: hasPk ? "present" : "no primary key — upserts and realtime may misbehave",
      rowCount: null,
    });
  }

  // 5. Database-wide: invalid indexes and unvalidated constraints in touched schemas.
  const schemas = [...new Set(targets.map((t) => parseQualified(t).schema))];
  if (schemas.length) {
    const list = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
    const bad = await safeRead(
      `select n.nspname || '.' || c.relname as obj from pg_index i
         join pg_class c on c.oid = i.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
        where not i.indisvalid and n.nspname in (${list})`,
    );
    checks.push({
      id: "indexes:valid",
      label: "Index validity",
      target: schemas.join(", "),
      status: bad.error ? "warn" : bad.rows.length ? "fail" : "pass",
      detail: bad.error ?? (bad.rows.length ? `Invalid: ${bad.rows.map((r) => String(r.obj)).join(", ")}` : "All indexes valid"),
      rowCount: bad.rows.length,
    });

    const notValid = await safeRead(
      `select n.nspname || '.' || c.relname || ' (' || con.conname || ')' as obj
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where not con.convalidated and n.nspname in (${list})`,
    );
    checks.push({
      id: "constraints:validated",
      label: "Constraint validation",
      target: schemas.join(", "),
      status: notValid.error ? "warn" : notValid.rows.length ? "warn" : "pass",
      detail: notValid.error ?? (notValid.rows.length ? `NOT VALID: ${notValid.rows.map((r) => String(r.obj)).join(", ")}` : "All constraints validated"),
      rowCount: notValid.rows.length,
    });
  }

  if (!targets.length) {
    checks.push({
      id: "targets:none",
      label: "Target discovery",
      target: "—",
      status: "warn",
      detail: "No tables or views could be derived from the selection or applied SQL",
      rowCount: 0,
    });
  }

  const counts = {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
  return {
    ok: counts.fail === 0,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    targets,
    counts,
    checks,
  };
}

/**
 * Run the suite for a job and record the outcome on the audit timeline.
 * Never throws — verification failures must not mask a successful apply.
 */
export async function runAndRecordSmoke(input: {
  jobId: string;
  selection: string[] | null;
  appliedSql: string | null;
  actorId: string | null;
  actorEmail: string | null;
  trigger: "auto" | "manual";
}): Promise<SmokeReport> {
  const { appendImportEvent, updateImportJob, getImportJobById } = await import("./import-jobs.server");
  let report: SmokeReport;
  try {
    report = await runSmokeChecks(input.selection, input.appliedSql);
  } catch (e) {
    report = {
      ok: false,
      ranAt: new Date().toISOString(),
      durationMs: 0,
      targets: [],
      counts: { pass: 0, warn: 0, fail: 1 },
      checks: [{
        id: "suite:error",
        label: "Verification suite",
        target: "—",
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
        rowCount: null,
      }],
    };
  }

  try {
    const job = await getImportJobById(input.jobId);
    const prev = (job?.report ?? {}) as Record<string, unknown>;
    await updateImportJob(input.jobId, { report: { ...prev, verification: report } });
  } catch { /* report persistence is best-effort */ }

  await appendImportEvent({
    jobId: input.jobId,
    step: "smoke_test",
    ok: report.ok,
    actorId: input.actorId,
    actorEmail: input.actorEmail,
    rowCount: report.checks.length,
    durationMs: report.durationMs,
    message: `Verification (${input.trigger}) — ${report.counts.pass} pass / ${report.counts.warn} warn / ${report.counts.fail} fail across ${report.targets.length} object(s)`,
    detail: {
      trigger: input.trigger,
      at: report.ranAt,
      actor: input.actorEmail,
      targets: report.targets,
      counts: report.counts,
      checks: report.checks,
    },
  });
  return report;
}
