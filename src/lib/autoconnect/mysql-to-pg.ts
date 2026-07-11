// Minimal MySQL DDL → PostgreSQL translator (regex-based, best-effort).
export function mysqlToPg(mysql: string): string {
  let s = mysql;
  // Strip ENGINE=, DEFAULT CHARSET=, COLLATE=, AUTO_INCREMENT=N
  s = s.replace(/\)\s*ENGINE\s*=\s*\w+[^;]*;/gi, ");");
  s = s.replace(/\s*DEFAULT\s+CHARSET\s*=\s*\w+/gi, "");
  s = s.replace(/\s*COLLATE\s*=?\s*\w+/gi, "");
  s = s.replace(/\s*AUTO_INCREMENT\s*=\s*\d+/gi, "");
  // Backticks → double-quotes
  s = s.replace(/`([^`]+)`/g, '"$1"');
  // Types
  s = s.replace(/\bINT\s+UNSIGNED\b/gi, "bigint");
  s = s.replace(/\bBIGINT\s+UNSIGNED\b/gi, "bigint");
  s = s.replace(/\bTINYINT\s*\(\s*1\s*\)/gi, "boolean");
  s = s.replace(/\bTINYINT(\s*\(\s*\d+\s*\))?/gi, "smallint");
  s = s.replace(/\bDATETIME\b/gi, "timestamptz");
  s = s.replace(/\bDOUBLE\b/gi, "double precision");
  s = s.replace(/\bLONGTEXT\b|\bMEDIUMTEXT\b|\bTINYTEXT\b/gi, "text");
  s = s.replace(/\bVARCHAR\s*\(\s*\d+\s*\)/gi, "text");
  s = s.replace(/\bJSON\b/gi, "jsonb");
  // AUTO_INCREMENT column → serial/bigserial (in-column)
  s = s.replace(/\bINT\b\s+AUTO_INCREMENT/gi, "serial");
  s = s.replace(/\bBIGINT\b\s+AUTO_INCREMENT/gi, "bigserial");
  s = s.replace(/\bAUTO_INCREMENT\b/gi, "");
  // ON UPDATE CURRENT_TIMESTAMP → drop (Postgres uses triggers)
  s = s.replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP/gi, "");
  // Boolean defaults
  s = s.replace(/DEFAULT\s+b?'?0'?/gi, "DEFAULT false");
  s = s.replace(/DEFAULT\s+b?'?1'?/gi, "DEFAULT true");
  // KEY/INDEX inline → separate CREATE INDEX (drop for now)
  s = s.replace(/,\s*KEY\s+"[^"]+"\s*\([^)]+\)/gi, "");
  s = s.replace(/,\s*INDEX\s+"[^"]+"\s*\([^)]+\)/gi, "");
  return s;
}
