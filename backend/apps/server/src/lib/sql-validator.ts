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

// Strip comments (-- to EOL, /* ... */) and single-quoted / dollar-quoted
// string bodies so we can safely search for semicolons and keywords.
export function stripLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      out += " ";
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += " ";
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      out += "''";                  // preserve as an empty literal
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      out += ch;                    // keep identifiers intact
      i++;
      while (i < sql.length && sql[i] !== '"') { out += sql[i]; i++; }
      if (i < sql.length) { out += sql[i]; i++; }
      continue;
    }
    if (ch === "$") {
      // Dollar-quoted: $tag$...$tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        out += " ";
        i = end < 0 ? sql.length : end + tag.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
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
    const raw = sql.slice(p.start, p.end).trim();
    if (!raw) continue;
    const m = /^\s*([A-Za-z]+)/.exec(raw);
    out.push({ index: out.length, verb: (m?.[1] ?? "").toUpperCase(), text: raw });
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
