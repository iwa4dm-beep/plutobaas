// SQL validator for the admin SQL runner.
//
// Two levels of enforcement:
//
//   1. STATEMENT CLASSIFIER — parses the SQL (stripped of comments and
//      strings) into a rough list of top-level statements so we can tell
//      SELECT from UPDATE without executing the SQL.
//
//   2. POLICY GATE — matches statements against an allowlist for the
//      current mode (read_only vs write) and against a permanent
//      blocklist that applies regardless of mode.
//
// Blocklist entries are always denied:
//   * ROLE/ACL escalations : SET ROLE, RESET ROLE, ALTER ROLE, CREATE ROLE,
//                            DROP ROLE, GRANT, REVOKE, ALTER USER, CREATE USER
//   * DB-wide destruction : DROP DATABASE, DROP SCHEMA, DROP TABLESPACE,
//                            ALTER SYSTEM
//   * Extension / superuser: CREATE EXTENSION, DROP EXTENSION, COPY (server-side)
//   * Session traps       : LISTEN, UNLISTEN, NOTIFY, LOAD, DEALLOCATE ALL
//
// The read-only mode additionally rejects anything whose top-level verb
// is not SELECT / WITH / EXPLAIN / SHOW.

export type Classified = {
  index: number;
  verb: string;                 // uppercased first keyword
  text: string;                 // the statement text (trimmed)
};

export type ValidationResult =
  | { ok: true; statements: Classified[] }
  | { ok: false; statements: Classified[]; error: string; offending?: Classified };

const BLOCKLIST_VERBS = new Set([
  "GRANT", "REVOKE", "COPY", "LOAD", "LISTEN", "UNLISTEN", "NOTIFY",
]);
// Multi-word blocklist patterns matched against the start of the statement.
const BLOCKLIST_PATTERNS: RegExp[] = [
  /^SET\s+ROLE\b/i,
  /^RESET\s+ROLE\b/i,
  /^SET\s+SESSION\s+AUTHORIZATION\b/i,
  /^ALTER\s+ROLE\b/i,
  /^ALTER\s+USER\b/i,
  /^CREATE\s+ROLE\b/i,
  /^CREATE\s+USER\b/i,
  /^DROP\s+ROLE\b/i,
  /^DROP\s+USER\b/i,
  /^DROP\s+DATABASE\b/i,
  /^DROP\s+SCHEMA\b/i,
  /^DROP\s+TABLESPACE\b/i,
  /^ALTER\s+SYSTEM\b/i,
  /^CREATE\s+EXTENSION\b/i,
  /^DROP\s+EXTENSION\b/i,
  /^DEALLOCATE\s+ALL\b/i,
  /^SET\s+SESSION\s+CHARACTERISTICS\b/i,
];

const READ_ONLY_VERBS = new Set([
  "SELECT", "WITH", "EXPLAIN", "SHOW", "VALUES", "TABLE",
]);

// Position-preserving strip: every replaced character becomes a space
// so that offsets into the returned string match offsets into the
// original. This lets splitStatements slice the original sql safely.
export function stripLiterals(sql: string): string {
  const out: string[] = new Array(sql.length);
  let i = 0;
  const pad = (from: number, to: number) => { for (let k = from; k < to; k++) out[k] = " "; };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl < 0 ? sql.length : nl;
      pad(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      pad(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      pad(start, i);
      continue;
    }
    if (ch === '"') {
      // Keep quoted identifiers intact (needed for `"user"` etc.).
      const start = i;
      out[i] = ch;
      i++;
      while (i < sql.length && sql[i] !== '"') { out[i] = sql[i]; i++; }
      if (i < sql.length) { out[i] = sql[i]; i++; }
      void start;
      continue;
    }
    if (ch === "$") {
      const rest = sql.slice(i);
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        pad(i, stop);
        i = stop;
        continue;
      }
    }
    out[i] = ch;
    i++;
  }
  for (let k = 0; k < out.length; k++) if (out[k] === undefined) out[k] = " ";
  return out.join("");
}

export function splitStatements(sql: string): Classified[] {
  const cleaned = stripLiterals(sql);
  const rawParts: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === ";") {
      rawParts.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start < cleaned.length) rawParts.push({ start, end: cleaned.length });

  const out: Classified[] = [];
  for (const p of rawParts) {
    // Use CLEANED slice for classification (comments stripped, literals
    // blanked out). The original text is kept for user-facing display.
    const cleanedRaw = cleaned.slice(p.start, p.end).trim().replace(/\s+/g, " ");
    if (!cleanedRaw) continue;
    const m = /^([A-Za-z]+)/.exec(cleanedRaw);
    out.push({ index: out.length, verb: (m?.[1] ?? "").toUpperCase(), text: cleanedRaw });
  }
  return out;
}

export function validateSql(sql: string, opts: { readOnly: boolean; maxStatements?: number }): ValidationResult {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { ok: false, statements, error: "no_statements" };
  const maxN = opts.maxStatements ?? 25;
  if (statements.length > maxN) {
    return { ok: false, statements, error: `too_many_statements:${statements.length}>${maxN}` };
  }
  for (const s of statements) {
    if (BLOCKLIST_VERBS.has(s.verb)) {
      return { ok: false, statements, error: `blocked_verb:${s.verb}`, offending: s };
    }
    for (const pat of BLOCKLIST_PATTERNS) {
      if (pat.test(s.text)) {
        return { ok: false, statements, error: `blocked_pattern:${pat.source}`, offending: s };
      }
    }
    if (opts.readOnly && !READ_ONLY_VERBS.has(s.verb)) {
      return { ok: false, statements, error: `write_in_read_only:${s.verb}`, offending: s };
    }
  }
  return { ok: true, statements };
}
