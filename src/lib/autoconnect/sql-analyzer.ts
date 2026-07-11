// Parse generated SQL into inspectable statements for dry-run preview.
import type { SqlStatement } from "./types";

const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|SCHEMA|POLICY)|TRUNCATE|ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN)\b/i;

export function analyzeSql(sql: string): SqlStatement[] {
  // Naive splitter: statements end on ;\n. Good enough for our generated output.
  const chunks = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out: SqlStatement[] = [];
  for (const raw of chunks) {
    const stmt = raw + ";";
    const s = stmt.replace(/^--[^\n]*\n?/gm, "").trim();
    if (!s || s === ";") continue;
    let kind: SqlStatement["kind"] = "other";
    let table: string | undefined;

    if (/^BEGIN/i.test(s)) kind = "begin";
    else if (/^COMMIT/i.test(s)) kind = "commit";
    else if (/^CREATE\s+TABLE/i.test(s)) {
      kind = "create_table";
      table = s.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?"?(\w+)"?/i)?.[1];
    } else if (/^ALTER\s+TABLE/i.test(s)) {
      kind = "alter";
      table = s.match(/ALTER\s+TABLE\s+(?:public\.)?"?(\w+)"?/i)?.[1];
      if (/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(s)) kind = "rls";
    } else if (/^DROP/i.test(s)) {
      kind = "drop";
      table = s.match(/DROP\s+\w+\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i)?.[1];
    } else if (/^GRANT/i.test(s)) {
      kind = "grant";
      table = s.match(/ON\s+(?:public\.)?"?(\w+)"?/i)?.[1];
    } else if (/^CREATE\s+POLICY/i.test(s)) {
      kind = "policy";
      table = s.match(/ON\s+(?:public\.)?"?(\w+)"?/i)?.[1];
    }
    out.push({ kind, table, destructive: DESTRUCTIVE.test(s), sql: stmt });
  }
  return out;
}

export type SqlImpact = {
  total: number;
  newTables: number;
  destructive: number;
  rlsEnabled: number;
  policies: number;
  grants: number;
  affectedTables: string[];
};

export function summarizeImpact(stmts: SqlStatement[]): SqlImpact {
  const tables = new Set<string>();
  let newTables = 0, destructive = 0, rlsEnabled = 0, policies = 0, grants = 0;
  for (const s of stmts) {
    if (s.table) tables.add(s.table);
    if (s.kind === "create_table") newTables++;
    if (s.destructive) destructive++;
    if (s.kind === "rls") rlsEnabled++;
    if (s.kind === "policy") policies++;
    if (s.kind === "grant") grants++;
  }
  return {
    total: stmts.length,
    newTables,
    destructive,
    rlsEnabled,
    policies,
    grants,
    affectedTables: Array.from(tables),
  };
}
