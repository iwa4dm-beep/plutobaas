// Client-safe SQL change classifier used by the Pluto Migrator diff view.
//
// Turns a generated migration into a readable list of create / alter / drop
// operations so an admin can review the impact BEFORE pressing Apply.
import { splitSqlStatements } from "./supabase-translate";

export type DiffOp = "create" | "alter" | "drop" | "insert" | "other";

export type DiffEntry = {
  op: DiffOp;
  objectType: string;
  name: string;
  statement: string;
  destructive: boolean;
};

export type SqlDiff = {
  entries: DiffEntry[];
  counts: Record<DiffOp, number>;
  destructiveCount: number;
};

const OBJECT_WORDS =
  "table|view|materialized view|index|unique index|schema|type|function|procedure|policy|trigger|sequence|extension|publication|role|column|constraint";

const RE = new RegExp(
  `^(create|alter|drop)\\s+(?:or\\s+replace\\s+)?(?:if\\s+not\\s+exists\\s+)?(${OBJECT_WORDS})\\s+(?:if\\s+exists\\s+)?(?:if\\s+not\\s+exists\\s+)?([a-zA-Z0-9_."']+)`,
  "i",
);

function clean(name: string): string {
  return name.replace(/["']/g, "").replace(/[(;,].*$/, "");
}

export function classifyStatement(raw: string): DiffEntry | null {
  const stmt = raw.trim();
  if (!stmt || stmt.startsWith("--")) return null;
  const compact = stmt.replace(/\s+/g, " ");
  const m = RE.exec(compact);
  if (m) {
    const op = m[1].toLowerCase() as DiffOp;
    const objectType = m[2].toLowerCase();
    const name = clean(m[3]);
    const destructive =
      op === "drop" ||
      /\bdrop\s+(column|constraint|default|not\s+null)\b/i.test(compact) ||
      /\btruncate\b/i.test(compact);
    return { op, objectType, name, statement: compact.slice(0, 4000), destructive };
  }
  if (/^insert\s+into\s+/i.test(compact)) {
    const n = /^insert\s+into\s+([a-zA-Z0-9_."]+)/i.exec(compact);
    return { op: "insert", objectType: "rows", name: clean(n?.[1] ?? "?"), statement: compact.slice(0, 4000), destructive: false };
  }
  if (/^truncate\b/i.test(compact) || /^delete\s+from\b/i.test(compact)) {
    return { op: "drop", objectType: "rows", name: clean(compact.split(/\s+/)[2] ?? "?"), statement: compact.slice(0, 4000), destructive: true };
  }
  return { op: "other", objectType: "statement", name: compact.slice(0, 60), statement: compact.slice(0, 4000), destructive: false };
}

export function diffSql(sql: string): SqlDiff {
  const entries: DiffEntry[] = [];
  for (const stmt of splitSqlStatements(sql)) {
    const e = classifyStatement(stmt);
    if (e) entries.push(e);
  }
  const counts: Record<DiffOp, number> = { create: 0, alter: 0, drop: 0, insert: 0, other: 0 };
  for (const e of entries) counts[e.op]++;
  return { entries, counts, destructiveCount: entries.filter((e) => e.destructive).length };
}
