// Client-side SQL bind-parameter + safety validator.
//
// This mirrors (a strict subset of) backend/apps/server/src/lib/sql-validator.ts
// so the dashboard can surface problems BEFORE round-tripping to the API:
//   - counts $N placeholders and matches against provided params length
//   - infers a display type per param slot
//   - warns on obviously disallowed statements (SET ROLE, GRANT, DROP DATABASE, …)
//   - flags write verbs when read-only is on
//
// Server enforcement is still the source of truth — this is UX only.

const BLOCKED_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bset\s+role\b/i,                label: "SET ROLE" },
  { re: /\breset\s+role\b/i,              label: "RESET ROLE" },
  { re: /\bset\s+session\s+authorization\b/i, label: "SET SESSION AUTHORIZATION" },
  { re: /\bgrant\b/i,                     label: "GRANT" },
  { re: /\brevoke\b/i,                    label: "REVOKE" },
  { re: /\balter\s+role\b/i,              label: "ALTER ROLE" },
  { re: /\balter\s+system\b/i,            label: "ALTER SYSTEM" },
  { re: /\bcreate\s+role\b/i,             label: "CREATE ROLE" },
  { re: /\bdrop\s+database\b/i,           label: "DROP DATABASE" },
  { re: /\bcreate\s+extension\b/i,        label: "CREATE EXTENSION" },
  { re: /\blisten\b/i,                    label: "LISTEN" },
  { re: /\bnotify\b/i,                    label: "NOTIFY" },
  { re: /\bcopy\b/i,                      label: "COPY" },
];

const WRITE_VERBS = /^\s*(insert|update|delete|truncate|drop|alter|create|grant|revoke|comment|reindex|vacuum|cluster|refresh|call|do)\b/i;

// Strip comments and quoted string bodies so pattern matching + placeholder
// scanning don't false-positive on `-- $1` or `'grant'`.
export function stripSqlLiterals(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "--") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      out += q;
      i++;
      while (i < src.length) {
        if (src[i] === q) {
          if (src[i + 1] === q) { out += "  "; i += 2; continue; } // escaped quote
          out += q; i++; break;
        }
        out += " "; i++;
      }
      continue;
    }
    // dollar-quoted body: $$ ... $$ or $tag$ ... $tag$
    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = src.indexOf(tag, i + tag.length);
        if (end === -1) { out += " ".repeat(src.length - i); i = src.length; }
        else { out += " ".repeat(end + tag.length - i); i = end + tag.length; }
        continue;
      }
    }
    out += ch; i++;
  }
  return out;
}

export type PlaceholderIssue = {
  kind: "unused_placeholder" | "missing_placeholder" | "gap" | "extra_param";
  message: string;
};

export type ClientValidationResult = {
  placeholders: number[];         // unique $N indexes referenced by the SQL
  maxIndex: number;               // 0 when none
  issues: PlaceholderIssue[];
  blocked: string[];              // labels of disallowed patterns found
  writeInReadOnly: boolean;
  paramTypes: { index: number; type: string }[];
};

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function validateClientSql(
  sql: string,
  params: unknown[],
  opts: { readOnly: boolean } = { readOnly: true }
): ClientValidationResult {
  const cleaned = stripSqlLiterals(sql);

  // Find $1, $2, … references. Postgres binds are 1-indexed and dense.
  const refs = new Set<number>();
  const re = /\$(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const n = Number(m[1]);
    if (n > 0) refs.add(n);
  }
  const placeholders = [...refs].sort((a, b) => a - b);
  const maxIndex = placeholders[placeholders.length - 1] ?? 0;

  const issues: PlaceholderIssue[] = [];

  // Gaps: $1, $3 without $2 is a hard Postgres error.
  for (let i = 1; i <= maxIndex; i++) {
    if (!refs.has(i)) {
      issues.push({ kind: "gap", message: `Placeholder $${i} is skipped — Postgres requires dense $1..$N.` });
    }
  }
  // Params provided vs referenced.
  if (params.length < maxIndex) {
    issues.push({ kind: "missing_placeholder", message: `SQL references $${maxIndex} but only ${params.length} param${params.length === 1 ? "" : "s"} provided.` });
  }
  if (params.length > maxIndex) {
    issues.push({ kind: "extra_param", message: `${params.length - maxIndex} unused param${params.length - maxIndex === 1 ? "" : "s"} — SQL only references up to $${maxIndex}.` });
  }

  // Blocked pattern scan (server will also reject; we surface it early).
  const blocked: string[] = [];
  for (const p of BLOCKED_PATTERNS) if (p.re.test(cleaned)) blocked.push(p.label);

  const writeInReadOnly = opts.readOnly && cleaned
    .split(";")
    .some((s) => WRITE_VERBS.test(s));

  const paramTypes = params.slice(0, Math.max(maxIndex, params.length))
    .map((v, i) => ({ index: i + 1, type: jsType(v) }));

  return { placeholders, maxIndex, issues, blocked, writeInReadOnly, paramTypes };
}
