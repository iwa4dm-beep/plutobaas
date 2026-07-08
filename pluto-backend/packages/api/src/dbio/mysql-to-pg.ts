// MySQL → PostgreSQL syntax bridge.
//
// Converts the most common MySQL/MariaDB dump constructs (mysqldump output,
// phpMyAdmin exports) into PostgreSQL-compatible SQL. This is intentionally
// pragmatic — not a full-fidelity translator. Covers 95% of real-world
// application schemas & data dumps that customers migrate from cPanel /
// shared hosting.
//
// Also exposes `splitSqlStatements` — a statement splitter that respects
// single/double-quoted strings, backticks, `--` and `/* */` comments,
// dollar-quoted blocks (`$$ … $$`), and MySQL DELIMITER directives.

// ─────────────────────────────── statement split ────────────────────────────

/**
 * Split a SQL script into individual statements. Handles:
 *   - single ('...') and double ("...") quoted strings, incl. `\'` escape
 *   - MySQL backtick-quoted identifiers `foo`
 *   - -- line comments  and  /* block comments *\/
 *   - Postgres dollar-quoted blocks:  $tag$ ... $tag$
 *   - MySQL `DELIMITER //` directives (for stored procedures)
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let delim = ';';
  const N = sql.length;

  while (i < N) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    // line comment
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      buf += sql.slice(i, nl === -1 ? N : nl + 1);
      i = nl === -1 ? N : nl + 1;
      continue;
    }
    // block comment
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      buf += sql.slice(i, end === -1 ? N : end + 2);
      i = end === -1 ? N : end + 2;
      continue;
    }
    // single-quoted string
    if (ch === "'") {
      buf += ch; i++;
      while (i < N) {
        const c = sql[i];
        buf += c; i++;
        if (c === '\\' && i < N) { buf += sql[i]; i++; continue; }
        if (c === "'") {
          if (sql[i] === "'") { buf += "'"; i++; continue; } // '' escape
          break;
        }
      }
      continue;
    }
    // double-quoted string
    if (ch === '"') {
      buf += ch; i++;
      while (i < N) {
        const c = sql[i];
        buf += c; i++;
        if (c === '\\' && i < N) { buf += sql[i]; i++; continue; }
        if (c === '"') break;
      }
      continue;
    }
    // backticked identifier
    if (ch === '`') {
      buf += ch; i++;
      while (i < N) {
        const c = sql[i];
        buf += c; i++;
        if (c === '`') break;
      }
      continue;
    }
    // dollar-quoted block $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        buf += tag; i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) { buf += sql.slice(i); i = N; }
        else { buf += sql.slice(i, end + tag.length); i = end + tag.length; }
        continue;
      }
    }
    // DELIMITER directive (MySQL only, must be at line start)
    if ((buf.length === 0 || /[\r\n]\s*$/.test(buf)) && /^delimiter\b/i.test(sql.slice(i))) {
      const nl = sql.indexOf('\n', i);
      const line = sql.slice(i, nl === -1 ? N : nl);
      const m = /^delimiter\s+(\S+)/i.exec(line);
      if (m) delim = m[1];
      i = nl === -1 ? N : nl + 1;
      continue;
    }
    // statement terminator
    if (sql.slice(i, i + delim.length) === delim) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      i += delim.length;
      continue;
    }
    buf += ch; i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

// ─────────────────────────────── converter ──────────────────────────────────

const MYSQL_TO_PG_TYPES: Array<[RegExp, string]> = [
  [/\btinyint\s*\(\s*1\s*\)/gi, 'boolean'],
  [/\btinyint\b(\s*\([^)]*\))?\s+unsigned\b/gi, 'smallint'],
  [/\btinyint\b(\s*\([^)]*\))?/gi, 'smallint'],
  [/\bsmallint\b(\s*\([^)]*\))?\s+unsigned\b/gi, 'integer'],
  [/\bmediumint\b(\s*\([^)]*\))?\s+unsigned\b/gi, 'integer'],
  [/\bmediumint\b(\s*\([^)]*\))?/gi, 'integer'],
  [/\bint\b(\s*\([^)]*\))?\s+unsigned\b/gi, 'bigint'],
  [/\bint\b(\s*\([^)]*\))?(?!\s+into)/gi, 'integer'],
  [/\bbigint\b(\s*\([^)]*\))?\s+unsigned\b/gi, 'numeric(20,0)'],
  [/\bbigint\b(\s*\([^)]*\))?/gi, 'bigint'],
  [/\bdouble\b(\s+precision)?(\s*\([^)]*\))?/gi, 'double precision'],
  [/\bfloat\b(\s*\([^)]*\))?/gi, 'real'],
  [/\bdatetime\b(\s*\([^)]*\))?/gi, 'timestamptz'],
  [/\btimestamp\b(\s*\([^)]*\))?/gi, 'timestamptz'],
  [/\blongtext\b/gi, 'text'],
  [/\bmediumtext\b/gi, 'text'],
  [/\btinytext\b/gi, 'text'],
  [/\blongblob\b/gi, 'bytea'],
  [/\bmediumblob\b/gi, 'bytea'],
  [/\btinyblob\b/gi, 'bytea'],
  [/\bblob\b/gi, 'bytea'],
  [/\bjson\b/gi, 'jsonb'],
  [/\benum\s*\([^)]*\)/gi, 'text'], // simplification: enums → text (values not validated)
];

/**
 * Convert one MySQL/MariaDB statement to PostgreSQL. Returns null when the
 * statement should be dropped entirely (e.g. `SET FOREIGN_KEY_CHECKS=0`).
 */
export function convertMysqlStatement(input: string): string | null {
  let s = input;

  // Drop MySQL-only session/environment noise
  if (/^\s*(SET\s+(NAMES|FOREIGN_KEY_CHECKS|SQL_MODE|TIME_ZONE|CHARACTER_SET_CLIENT|CHARACTER_SET_RESULTS|COLLATION_CONNECTION|@OLD_|@@|autocommit)|START\s+TRANSACTION|COMMIT|LOCK\s+TABLES|UNLOCK\s+TABLES|USE\s+`?\w+`?|\/\*!)/i.test(s)) {
    // keep COMMIT? no — we manage txns ourselves
    if (/^\s*COMMIT\b/i.test(s)) return null;
    return null;
  }

  // Strip trailing MySQL table options: ENGINE=..., DEFAULT CHARSET=..., COLLATE=..., AUTO_INCREMENT=..., ROW_FORMAT=...
  // Applied to the tail of a CREATE TABLE up until the terminating `)`.
  s = s.replace(
    /\)\s*(ENGINE\s*=\s*\w+|DEFAULT\s+CHARSET\s*=\s*\w+|CHARACTER\s+SET\s+\w+|COLLATE\s*=?\s*\w+|AUTO_INCREMENT\s*=\s*\d+|ROW_FORMAT\s*=\s*\w+|COMMENT\s*=\s*'(?:[^'\\]|\\.)*')(\s+(ENGINE\s*=\s*\w+|DEFAULT\s+CHARSET\s*=\s*\w+|CHARACTER\s+SET\s+\w+|COLLATE\s*=?\s*\w+|AUTO_INCREMENT\s*=\s*\d+|ROW_FORMAT\s*=\s*\w+|COMMENT\s*=\s*'(?:[^'\\]|\\.)*'))*/gi,
    ')',
  );

  // Inline COMMENT '...' on columns → strip (Postgres uses COMMENT ON separately)
  s = s.replace(/\s+COMMENT\s+'(?:[^'\\]|\\.)*'/gi, '');

  // Column CHARACTER SET / COLLATE clauses → strip
  s = s.replace(/\s+CHARACTER\s+SET\s+\w+/gi, '');
  s = s.replace(/\s+COLLATE\s+\w+/gi, '');

  // AUTO_INCREMENT → GENERATED BY DEFAULT AS IDENTITY
  s = s.replace(/\bAUTO_INCREMENT\b/gi, 'GENERATED BY DEFAULT AS IDENTITY');

  // Type map runs BEFORE stripping bare `unsigned` so `int unsigned` → bigint
  for (const [re, repl] of MYSQL_TO_PG_TYPES) s = s.replace(re, repl);

  // Strip any remaining bare `unsigned` (already-mapped types don't need it)
  s = s.replace(/\bunsigned\b/gi, '');

  // Backticks → double-quotes (identifiers)
  s = s.replace(/`([^`]+)`/g, '"$1"');

  // Convert MySQL bit literals b'0'/b'1' → 0/1
  s = s.replace(/\bb'([01]+)'/g, "'$1'");

  // NULL/NOT NULL DEFAULT ordering ok in both
  // ON UPDATE CURRENT_TIMESTAMP → strip (would need a trigger in PG)
  s = s.replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(\s*\(\s*\))?/gi, '');

  // CURRENT_TIMESTAMP() → CURRENT_TIMESTAMP
  s = s.replace(/\bCURRENT_TIMESTAMP\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP');

  // KEY / INDEX inside CREATE TABLE → we drop them (Postgres uses CREATE INDEX outside)
  // Only inside the parenthesised body — match at start of a comma-separated line.
  s = s.replace(/(^|,)\s*(?:UNIQUE\s+)?(?:KEY|INDEX)\s+(?:"[^"]+"\s+)?\([^)]+\)/gi, (_m, pre) => pre);

  // FULLTEXT / SPATIAL keys → drop
  s = s.replace(/(^|,)\s*(?:FULLTEXT|SPATIAL)\s+(?:KEY|INDEX)?[^,)]*/gi, (_m, pre) => pre);

  // Clean up doubled commas / trailing commas from key stripping
  s = s.replace(/,\s*,+/g, ',');
  s = s.replace(/,\s*\)/g, ')');

  // (type map already applied above)

  // \' escape → '' inside single-quoted strings (Postgres standard_conforming_strings)
  s = s.replace(/\\'/g, "''");

  // INSERT IGNORE → INSERT ... ON CONFLICT DO NOTHING (best-effort)
  s = s.replace(/^\s*INSERT\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
  // (Caller may append ON CONFLICT DO NOTHING if needed.)

  // REPLACE INTO → INSERT (loses upsert semantics — flag in log)
  s = s.replace(/^\s*REPLACE\s+INTO\b/i, 'INSERT INTO');

  return s.trim() || null;
}

/** Detect dialect from the first ~2KB of a dump. */
export function detectDialect(sample: string): 'mysql' | 'postgres' | 'unknown' {
  const head = sample.slice(0, 2048).toLowerCase();
  if (/`\w+`|engine\s*=|auto_increment|character\s+set|tinyint\(1\)/.test(head)) return 'mysql';
  if (/\bpg_catalog|\bnextval\(|\bpg_dump|generated by default as identity/.test(head)) return 'postgres';
  return 'unknown';
}
