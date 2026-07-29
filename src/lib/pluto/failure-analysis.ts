// Client-safe failure analyzer for import jobs.
//
// Takes the raw Postgres/HTTP error text recorded on a failed dry-run or apply
// step and turns it into: a human summary, likely root-cause tags, and the SQL
// snippet from the generated migration that most likely produced it.
import { splitSqlStatements } from "./supabase-translate";

export type RootCauseTag = {
  code: string;
  label: string;
  hint: string;
  severity: "error" | "warning";
};

export type FailureAnalysis = {
  summary: string;
  raw: string;
  tags: RootCauseTag[];
  objectName: string | null;
  snippet: string | null;
  snippetIndex: number | null;
};

type Rule = { code: string; label: string; hint: string; test: RegExp; severity?: "error" | "warning" };

const RULES: Rule[] = [
  {
    code: "missing_extension",
    label: "Missing extension",
    hint: 'The dump uses an extension that is not installed. Add `create extension if not exists "<name>";` at the top of the migration.',
    test: /extension\s+"?[\w-]+"?\s+(?:is not available|does not exist)|could not open extension control file/i,
  },
  {
    code: "undefined_table",
    label: "Referenced table missing",
    hint: "A dependent table/view was excluded by your selection. Re-select the referenced object and re-translate.",
    test: /relation\s+"?[\w.]+"?\s+does not exist/i,
  },
  {
    code: "undefined_column",
    label: "Column missing",
    hint: "The dump targets a column that does not exist in Pluto yet — include the parent table's CREATE statement.",
    test: /column\s+"?[\w.]+"?\s+(?:of relation .*)?does not exist/i,
  },
  {
    code: "duplicate_object",
    label: "Object already exists",
    hint: "The object exists in Pluto. Re-translate (idempotent mode adds IF NOT EXISTS) or drop the conflicting object first.",
    test: /already exists|duplicate key value violates unique constraint/i,
  },
  {
    code: "undefined_role",
    label: "Unknown role",
    hint: "Supabase roles (anon, authenticated, service_role) must exist in Pluto. Create the role or drop the GRANT.",
    test: /role\s+"?[\w-]+"?\s+does not exist/i,
  },
  {
    code: "auth_schema",
    label: "Supabase auth.* dependency",
    hint: "The statement references Supabase-managed `auth.*` objects. The translator normally rewrites these — check the rewritten SQL.",
    test: /\bauth\.(uid|role|jwt|users)\b/i,
  },
  {
    code: "permission_denied",
    label: "Permission denied",
    hint: "The service-role connection lacks privileges for this object. Grant ownership or run it as the DB owner.",
    test: /permission denied|must be owner of/i,
  },
  {
    code: "syntax_error",
    label: "SQL syntax error",
    hint: "A statement did not survive translation. Open the SQL viewer and fix the statement, then re-translate.",
    test: /syntax error at or near/i,
  },
  {
    code: "fk_violation",
    label: "Foreign key violation",
    hint: "Seed rows reference missing parents. Import parent tables first, or exclude the data statements.",
    test: /violates foreign key constraint/i,
  },
  {
    code: "not_null",
    label: "NOT NULL violation",
    hint: "Existing rows conflict with a NOT NULL column. Add a default, or backfill before applying.",
    test: /null value in column .* violates not-null constraint/i,
  },
  {
    code: "timeout",
    label: "Statement timeout",
    hint: "The migration exceeded the execution window. Split the selection into smaller batches and retry.",
    test: /timeout|canceling statement due to/i,
    severity: "warning",
  },
  {
    code: "connectivity",
    label: "Backend unreachable",
    hint: "The Pluto API/SQL endpoint did not respond. Check the VPS and retry — nothing was applied.",
    test: /fetch failed|ECONNREFUSED|ETIMEDOUT|502|503|504/i,
  },
  {
    code: "unauthorized",
    label: "Service credentials rejected",
    hint: "The service-role key was rejected (401/403). Refresh the Pluto service key in project secrets.",
    test: /unauthorized|forbidden|401|403/i,
  },
];

/** Extract the quoted object name Postgres reports in most DDL errors. */
export function extractObjectName(raw: string): string | null {
  const m =
    /relation\s+"([\w.]+)"/i.exec(raw) ??
    /table\s+"([\w.]+)"/i.exec(raw) ??
    /column\s+"([\w.]+)"/i.exec(raw) ??
    /type\s+"([\w.]+)"/i.exec(raw) ??
    /constraint\s+"([\w.]+)"/i.exec(raw) ??
    /function\s+"?([\w.]+)"?/i.exec(raw);
  return m ? m[1] : null;
}

/** Find the statement in `sql` most likely responsible for `raw`. */
export function locateSnippet(sql: string | null, raw: string): { snippet: string | null; index: number | null } {
  if (!sql) return { snippet: null, index: null };
  const stmts = splitSqlStatements(sql);
  const name = extractObjectName(raw);
  if (name) {
    const bare = name.includes(".") ? name.split(".").pop()! : name;
    const i = stmts.findIndex((s) => new RegExp(`\\b${bare.replace(/[^\w]/g, "")}\\b`, "i").test(s));
    if (i >= 0) return { snippet: stmts[i].trim().slice(0, 4000), index: i + 1 };
  }
  const near = /syntax error at or near "([^"]+)"/i.exec(raw)?.[1];
  if (near) {
    const i = stmts.findIndex((s) => s.includes(near));
    if (i >= 0) return { snippet: stmts[i].trim().slice(0, 4000), index: i + 1 };
  }
  return { snippet: null, index: null };
}

export function analyzeFailure(rawInput: string | null | undefined, sql: string | null): FailureAnalysis {
  const raw = (rawInput ?? "").toString();
  const tags: RootCauseTag[] = RULES.filter((r) => r.test.test(raw)).map((r) => ({
    code: r.code,
    label: r.label,
    hint: r.hint,
    severity: r.severity ?? "error",
  }));
  if (!tags.length && raw) {
    tags.push({
      code: "unclassified",
      label: "Unclassified error",
      hint: "No known pattern matched. Inspect the raw error and the generated SQL below.",
      severity: "warning",
    });
  }
  const { snippet, index } = locateSnippet(sql, raw);
  const first = raw.split("\n").find((l) => l.trim().length > 0) ?? "Unknown failure";
  return {
    summary: first.slice(0, 400),
    raw: raw.slice(0, 8000),
    tags,
    objectName: extractObjectName(raw),
    snippet,
    snippetIndex: index,
  };
}
