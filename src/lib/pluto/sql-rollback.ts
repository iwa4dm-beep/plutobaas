// Rollback / undo generator for applied import migrations.
//
// Takes the exact SQL that was applied (read back from the version archive)
// and derives the inverse script: every object the migration CREATEd is
// DROPped, every ADD COLUMN is dropped again — in reverse order so that
// dependants go first. Statements whose effect cannot be inverted safely
// (DROP, INSERT/UPDATE/DELETE, arbitrary DO blocks) are reported as
// `unsupported` so the operator sees exactly what the undo will NOT restore.
import { splitSqlStatements } from "./supabase-translate";

export type RollbackEntry = {
  /** Inverse statement to execute. */
  statement: string;
  /** Object it removes, e.g. `public.notes`. */
  name: string;
  objectType: string;
};

export type RollbackUnsupported = {
  statement: string;
  reason: string;
};

export type RollbackPlan = {
  sql: string;
  entries: RollbackEntry[];
  unsupported: RollbackUnsupported[];
};

const IDENT = String.raw`(?:"[^"]+"|[a-zA-Z_][\w$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

type Matcher = {
  objectType: string;
  re: RegExp;
  /** Build the inverse statement from the regex match. */
  invert: (m: RegExpMatchArray) => string;
  name: (m: RegExpMatchArray) => string;
};

const MATCHERS: Matcher[] = [
  {
    objectType: "table",
    re: new RegExp(String.raw`^create\s+(?:unlogged\s+|temp\s+|temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, "i"),
    invert: (m) => `drop table if exists ${m[1]} cascade;`,
    name: (m) => m[1],
  },
  {
    objectType: "materialized view",
    re: new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?materialized\s+view\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, "i"),
    invert: (m) => `drop materialized view if exists ${m[1]} cascade;`,
    name: (m) => m[1],
  },
  {
    objectType: "view",
    re: new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?view\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, "i"),
    invert: (m) => `drop view if exists ${m[1]} cascade;`,
    name: (m) => m[1],
  },
  {
    objectType: "index",
    re: new RegExp(String.raw`^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, "i"),
    invert: (m) => `drop index if exists ${m[1]};`,
    name: (m) => m[1],
  },
  {
    objectType: "policy",
    re: new RegExp(String.raw`^create\s+policy\s+(${IDENT})\s+on\s+(${QUALIFIED})`, "i"),
    invert: (m) => `drop policy if exists ${m[1]} on ${m[2]};`,
    name: (m) => `${m[2]}.${m[1]}`,
  },
  {
    objectType: "trigger",
    re: new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?trigger\s+(${IDENT})[\s\S]*?\bon\s+(${QUALIFIED})`, "i"),
    invert: (m) => `drop trigger if exists ${m[1]} on ${m[2]};`,
    name: (m) => `${m[2]}.${m[1]}`,
  },
  {
    objectType: "function",
    re: new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?function\s+(${QUALIFIED})\s*\(([^)]*)\)`, "i"),
    invert: (m) => `drop function if exists ${m[1]}(${clean(m[2])}) cascade;`,
    name: (m) => m[1],
  },
  {
    objectType: "type",
    re: new RegExp(String.raw`^create\s+type\s+(${QUALIFIED})`, "i"),
    invert: (m) => `drop type if exists ${m[1]} cascade;`,
    name: (m) => m[1],
  },
  {
    objectType: "sequence",
    re: new RegExp(String.raw`^create\s+sequence\s+(?:if\s+not\s+exists\s+)?(${QUALIFIED})`, "i"),
    invert: (m) => `drop sequence if exists ${m[1]} cascade;`,
    name: (m) => m[1],
  },
  {
    objectType: "schema",
    re: new RegExp(String.raw`^create\s+schema\s+(?:if\s+not\s+exists\s+)?(${IDENT})`, "i"),
    invert: (m) => `drop schema if exists ${m[1]} cascade;`,
    name: (m) => m[1],
  },
  {
    objectType: "column",
    re: new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(${IDENT})`, "i"),
    invert: (m) => `alter table if exists ${m[1]} drop column if exists ${m[2]} cascade;`,
    name: (m) => `${m[1]}.${m[2]}`,
  },
  {
    objectType: "constraint",
    re: new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s+add\s+constraint\s+(${IDENT})`, "i"),
    invert: (m) => `alter table if exists ${m[1]} drop constraint if exists ${m[2]};`,
    name: (m) => `${m[1]}.${m[2]}`,
  },
];

const NON_INVERTIBLE: Array<{ re: RegExp; reason: string }> = [
  { re: /^insert\s+into/i, reason: "Data insert — rows are not removed automatically; delete them manually if needed." },
  { re: /^update\s+/i, reason: "Data update — previous values are not recoverable from the migration." },
  { re: /^delete\s+from/i, reason: "Data delete — removed rows cannot be restored by an undo." },
  { re: /^drop\s+/i, reason: "The migration dropped this object; the undo cannot recreate it." },
  { re: /^truncate\s+/i, reason: "Truncated data cannot be restored by an undo." },
  { re: /^grant\s+|^revoke\s+/i, reason: "Privilege change — review and restore grants manually." },
  { re: /^do\s*\$\$|^do\s+\$/i, reason: "Anonymous DO block — its effect cannot be inverted automatically." },
  { re: /^alter\s+/i, reason: "ALTER without ADD COLUMN/CONSTRAINT — the previous definition is unknown." },
  { re: /^create\s+extension/i, reason: "Extension left in place on purpose — dropping it could break other schemas." },
];

/** Build the inverse script for a migration that was applied. */
export function buildRollbackPlan(appliedSql: string): RollbackPlan {
  const statements = splitSqlStatements(appliedSql);
  const entries: RollbackEntry[] = [];
  const unsupported: RollbackUnsupported[] = [];

  for (const raw of statements) {
    const s = clean(raw);
    if (!s) continue;
    let matched = false;
    for (const m of MATCHERS) {
      const hit = s.match(m.re);
      if (hit) {
        entries.push({ statement: m.invert(hit), name: m.name(hit), objectType: m.objectType });
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const bad = NON_INVERTIBLE.find((n) => n.re.test(s));
    unsupported.push({
      statement: s.slice(0, 400),
      reason: bad?.reason ?? "No inverse rule for this statement.",
    });
  }

  // Reverse order: dependants (policies, indexes, columns) are dropped before
  // the tables/schemas they hang off. `cascade` covers the rest.
  entries.reverse();

  // De-duplicate identical inverse statements while preserving order.
  const seen = new Set<string>();
  const unique = entries.filter((e) => (seen.has(e.statement) ? false : (seen.add(e.statement), true)));

  const header = [
    "-- Rollback generated by Pluto Migrator",
    "-- Inverts the statements of the applied import migration.",
    unsupported.length
      ? `-- ${unsupported.length} statement(s) could not be inverted automatically — see the panel.`
      : "-- All statements were invertible.",
    "",
  ].join("\n");

  return {
    sql: unique.length ? `${header}${unique.map((e) => e.statement).join("\n")}\n` : "",
    entries: unique,
    unsupported,
  };
}
