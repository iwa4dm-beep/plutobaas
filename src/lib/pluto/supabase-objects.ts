// Client-safe inventory of a Supabase dump: which schemas / tables / views /
// functions it contains, and how to generate a migration for a SUBSET of them.
import { splitSqlStatements } from "./supabase-translate";

export type DumpObjectKind = "schema" | "table" | "view" | "function" | "type" | "other";

export type DumpObject = {
  /** Stable selection key, e.g. `table:public.notes`. */
  key: string;
  kind: DumpObjectKind;
  schema: string;
  name: string;
  /** Number of statements attributed to this object (table + its policies/indexes). */
  statements: number;
};

function qualify(raw: string): { schema: string; name: string } {
  const clean = raw.replace(/["']/g, "").replace(/[(;,].*$/, "");
  const parts = clean.split(".");
  if (parts.length >= 2) return { schema: parts[0], name: parts.slice(1).join(".") };
  return { schema: "public", name: clean };
}

/** Which object a statement belongs to — null means "always include". */
export function ownerKeyOf(statement: string): string | null {
  const s = statement.replace(/\s+/g, " ").trim();

  let m = /^create\s+schema\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) return `schema:${qualify(m[1]).name}`;

  m = /^create\s+(?:or\s+replace\s+)?(materialized\s+view|view)\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[2]); return `view:${q.schema}.${q.name}`; }

  m = /^create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[1]); return `function:${q.schema}.${q.name}`; }

  m = /^create\s+type\s+([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[1]); return `type:${q.schema}.${q.name}`; }

  m = /^create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[1]); return `table:${q.schema}.${q.name}`; }

  m = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[1]); return `table:${q.schema}.${q.name}`; }

  m = /^(?:drop\s+policy[^;]*?on|create\s+policy[^;]*?\bon)\s+([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[1]); return `table:${q.schema}.${q.name}`; }

  m = /^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[a-zA-Z0-9_."]+\s+on\s+(?:only\s+)?([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[1]); return `table:${q.schema}.${q.name}`; }

  m = /^create\s+trigger\s+[a-zA-Z0-9_."]+[\s\S]*?\bon\s+([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[1]); return `table:${q.schema}.${q.name}`; }

  m = /^insert\s+into\s+([a-zA-Z0-9_."]+)/i.exec(s);
  if (m) { const q = qualify(m[1]); return `table:${q.schema}.${q.name}`; }

  return null;
}

const KIND_ORDER: DumpObjectKind[] = ["schema", "type", "table", "view", "function", "other"];

/** Inventory every selectable object in a raw Supabase dump. */
export function inventoryDump(rawSql: string): DumpObject[] {
  const map = new Map<string, DumpObject>();
  for (const stmt of splitSqlStatements(rawSql)) {
    const key = ownerKeyOf(stmt);
    if (!key) continue;
    const [kind, qualified] = key.split(":");
    const q = qualify(qualified);
    const existing = map.get(key);
    if (existing) existing.statements++;
    else {
      map.set(key, {
        key,
        kind: (KIND_ORDER.includes(kind as DumpObjectKind) ? kind : "other") as DumpObjectKind,
        schema: kind === "schema" ? qualified : q.schema,
        name: kind === "schema" ? qualified : q.name,
        statements: 1,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.schema.localeCompare(b.schema) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Keep only statements belonging to the selected objects.
 * Statements with no attributable owner (extensions, grants, SET…) are kept —
 * the translator drops the Supabase-specific ones afterwards.
 */
export function filterDumpBySelection(rawSql: string, selectedKeys: string[]): string {
  if (!selectedKeys.length) return rawSql;
  const wanted = new Set(selectedKeys);
  const out: string[] = [];
  for (const stmt of splitSqlStatements(rawSql)) {
    const key = ownerKeyOf(stmt);
    if (key === null || wanted.has(key)) out.push(`${stmt};`);
  }
  return out.join("\n\n") + "\n";
}
